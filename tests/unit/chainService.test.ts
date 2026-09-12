import type { AddressInfo, ChainTx, TokenInfo } from '@qbtc/chain'
import { describe, expect, it } from 'vitest'
import { ChainService, type ChainBackend } from '../../src/main/wallet/ChainService'
import type { DiscoveryBranch } from '../../src/main/wallet/discovery'

const ZERO = { fundedTxCount: 0, fundedSum: 0n, spentTxCount: 0, spentSum: 0n }

function emptyInfo(address: string): AddressInfo {
  return { address, chain: ZERO, mempool: ZERO, tokens: {} }
}
function fundedInfo(address: string, funded: bigint): AddressInfo {
  return {
    address,
    chain: { fundedTxCount: 1, fundedSum: funded, spentTxCount: 0, spentSum: 0n },
    mempool: ZERO,
    tokens: {},
  }
}

const derive = (chain: 0 | 1, index: number): string => `addr-${chain}-${index}`
// One classical (ecdsa) derive branch with zero floors — the discovery behavior the
// old (derive, floors) constructor produced.
const branches = async (): Promise<DiscoveryBranch[]> => [
  { kind: 'derive', algo: 'ecdsa', derive, floors: { receive: 0, change: 0 } },
]

function backend(over: {
  infos?: Record<string, AddressInfo>
  txs?: Record<string, ChainTx[]>
  tx?: Record<string, ChainTx>
  rawHex?: Record<string, string>
  fees?: Record<string, number>
  tokenInfo?: Record<string, TokenInfo>
  onLookup?: () => void
}): ChainBackend {
  return {
    getBlockchainInfo: async () => ({ tipHeight: 1000, tipHash: 'hash', network: 'mainnet' }),
    getAddressInfo: async (address: string) => {
      over.onLookup?.()
      return over.infos?.[address] ?? emptyInfo(address)
    },
    getAddressTransactions: async (address: string) => over.txs?.[address] ?? [],
    getTransaction: async (txid: string) => {
      const tx = over.tx?.[txid]
      if (tx === undefined) throw new Error(`no tx ${txid}`)
      return tx
    },
    getTransactionHex: async (txid: string) => over.rawHex?.[txid] ?? '00',
    getFeeEstimates: async () => over.fees ?? { '1': 12, '6': 5, '144': 1 },
    getTokenInfo: async (id: string) => over.tokenInfo?.[id] ?? { id, decimals: 6 },
  }
}

function withTokens(address: string, tokens: Record<string, bigint>): AddressInfo {
  return { address, chain: { fundedTxCount: 1, fundedSum: 0n, spentTxCount: 0, spentSum: 0n }, mempool: ZERO, tokens }
}

describe('ChainService', () => {
  it('sums balance across discovered addresses', async () => {
    const svc = new ChainService(
      backend({ infos: { 'addr-0-0': fundedInfo('addr-0-0', 150n), 'addr-0-1': fundedInfo('addr-0-1', 50n) } }),
      branches,
    )
    const summary = await svc.getSummary()
    expect(summary.balanceAtomic).toBe('200')
    expect(summary.tipHeight).toBe(1000)
  })

  it('stops scanning after the gap limit of unused addresses', async () => {
    let calls = 0
    const svc = new ChainService(backend({ onLookup: () => calls++ }), branches)
    await svc.getSummary()
    // Receive gap (20) + change gap (6).
    expect(calls).toBe(26)
  })

  it('classifies an incoming transaction', async () => {
    const tx: ChainTx = {
      txid: 'tx1',
      version: 1,
      vin: [],
      vout: [{ value: 70n, scripthash: 'sh', address: 'addr-0-0' }],
      size: 200,
      fee: 5n,
      status: { confirmed: true, blockHeight: 900 },
    }
    const svc = new ChainService(
      backend({ infos: { 'addr-0-0': fundedInfo('addr-0-0', 70n) }, txs: { 'addr-0-0': [tx] } }),
      branches,
    )
    const { items } = await svc.getHistory()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ txid: 'tx1', direction: 'in', amountAtomic: '70', feeAtomic: '5' })
  })

  it('scans every scheme branch and tags spendable addresses with their scheme', async () => {
    // Two schemes (active first), distinct address namespaces — mimicking a
    // post-coin_type-migration wallet with funds left on the legacy scheme.
    const multiBranches = async (): Promise<DiscoveryBranch[]> => [
      { kind: 'derive', algo: 'ecdsa', scheme: 'fake-v2', derive: (c, i) => `v2-${c}-${i}`, floors: { receive: 0, change: 0 } },
      { kind: 'derive', algo: 'ecdsa', scheme: 'fake-v1', derive: (c, i) => `v1-${c}-${i}`, floors: { receive: 0, change: 0 } },
    ]
    const svc = new ChainService(
      backend({ infos: { 'v2-0-0': fundedInfo('v2-0-0', 10n), 'v1-0-1': fundedInfo('v1-0-1', 25n) } }),
      multiBranches,
    )
    // Balance sums across BOTH schemes' branches.
    expect((await svc.getSummary()).balanceAtomic).toBe('35')
    const active = await svc.spendableAddresses()
    expect(active).toHaveLength(2)
    expect(active.find((a) => a.address === 'v2-0-0')).toMatchObject({ scheme: 'fake-v2', algo: 'ecdsa', chain: 0, index: 0 })
    expect(active.find((a) => a.address === 'v1-0-1')).toMatchObject({ scheme: 'fake-v1', algo: 'ecdsa', chain: 0, index: 1 })
  })

  it('maps fee estimates to fast/medium/slow bands', async () => {
    const svc = new ChainService(backend({ fees: { '1': 20, '6': 8, '144': 2 } }), branches)
    expect(await svc.estimateFee()).toEqual({ fast: 20, medium: 8, slow: 2 })
  })

  it('aggregates token balances across addresses and attaches metadata', async () => {
    const svc = new ChainService(
      backend({
        infos: { 'addr-0-0': withTokens('addr-0-0', { tokA: 100n }), 'addr-0-1': withTokens('addr-0-1', { tokA: 50n, tokB: 7n }) },
        tokenInfo: { tokA: { id: 'tokA', decimals: 6, symbol: 'AAA', name: 'Token A' } },
      }),
      branches,
    )
    const tokens = await svc.listTokens()
    const a = tokens.find((t) => t.id === 'tokA')!
    const b = tokens.find((t) => t.id === 'tokB')!
    expect(a).toMatchObject({ amountAtomic: '150', decimals: 6, symbol: 'AAA', name: 'Token A' }) // summed across addresses
    expect(b).toMatchObject({ amountAtomic: '7', decimals: 6 }) // no metadata → fallback decimals, no symbol
    expect(b.symbol).toBeUndefined()
  })

  it('builds tx detail with confirmations, totals and ours/pq marks', async () => {
    const tx: ChainTx = {
      txid: 'd1',
      version: 1,
      vin: [{ txid: 'p', vout: 0, prevoutValue: 100n, prevoutAddress: 'EXT' }],
      vout: [
        { value: 70n, scripthash: 'sh', address: 'addr-0-0' },
        { value: 25n, scripthash: 'sh2', address: 'EXT2' },
      ],
      size: 200,
      fee: 5n,
      status: { confirmed: true, blockHeight: 990 },
    }
    const svc = new ChainService(backend({ infos: { 'addr-0-0': fundedInfo('addr-0-0', 70n) }, tx: { d1: tx } }), branches)
    const detail = await svc.getTxDetail('d1')
    expect(detail.confirmations).toBe(11) // tip 1000 − 990 + 1
    expect(detail.totalInAtomic).toBe('100')
    expect(detail.totalOutAtomic).toBe('95')
    expect(detail.feeAtomic).toBe('5')
    expect(detail.inputs[0]).toMatchObject({ address: 'EXT', own: false })
    expect(detail.outputs[0]).toMatchObject({ address: 'addr-0-0', own: true, pq: false })
    expect(detail.outputs[1]).toMatchObject({ address: 'EXT2', own: false })
  })

  it('surfaces advanced detail: outpoint, signature scheme, scripts, header and raw hex', async () => {
    const tx: ChainTx = {
      txid: 'adv1',
      version: 2, // stake
      vin: [
        {
          txid: 'prev',
          vout: 3,
          prevoutValue: 100n,
          prevoutAddress: 'EXT',
          prevoutScripthash: 'aabb',
          redeemScript: '2103deadac',
          siglist: ['01013045aa'], // sighash 01, algo 01 → ECDSA
        },
      ],
      vout: [{ value: 95n, scripthash: 'ccdd', address: 'addr-0-0' }],
      size: 222,
      fee: 5n,
      status: { confirmed: true, blockHeight: 990, blockHash: 'bh', blockPos: 0 },
      isCoinbase: false,
    }
    const svc = new ChainService(backend({ infos: { 'addr-0-0': fundedInfo('addr-0-0', 95n) }, tx: { adv1: tx }, rawHex: { adv1: 'deadbeef' } }), branches)
    const detail = await svc.getTxDetail('adv1')
    expect(detail.txType).toBe(2)
    expect(detail.blockHash).toBe('bh')
    expect(detail.blockPos).toBe(0)
    expect(detail.isCoinbase).toBe(false)
    expect(detail.inputs[0]).toMatchObject({ prevoutTxid: 'prev', prevoutVout: 3, scripthash: 'aabb', redeemScript: '2103deadac', sigScheme: 'ecdsa' })
    expect(detail.outputs[0]).toMatchObject({ scripthash: 'ccdd' })
    expect(await svc.getTxRaw('adv1')).toBe('deadbeef')
  })

  it('surfaces a token receive as the token movement, not native coin', async () => {
    // A token output carries zero native value; the receive is the token amount.
    const tx: ChainTx = {
      txid: 'tk1',
      version: 4,
      vin: [],
      vout: [{ value: 0n, scripthash: 'sh', address: 'addr-0-0', tokenId: 'tokA', tokenAmount: 15_000_000n, tokenDecimals: 6 }],
      size: 250,
      fee: 0n,
      status: { confirmed: true, blockHeight: 950 },
    }
    const svc = new ChainService(
      backend({
        infos: { 'addr-0-0': withTokens('addr-0-0', { tokA: 15_000_000n }) },
        txs: { 'addr-0-0': [tx] },
        // Node stores the ticker in `name` here; tickerOf picks the shorter label.
        tokenInfo: { tokA: { id: 'tokA', decimals: 6, symbol: 'Tether USD', name: 'USDT' } },
      }),
      branches,
    )
    const { items } = await svc.getHistory()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ txid: 'tk1', direction: 'in', amountAtomic: '0', tokenId: 'tokA', tokenAmountAtomic: '15000000', tokenDecimals: 6, tokenTicker: 'USDT' })
  })

  it('surfaces a token send as outgoing by the amount sent to others (ignoring token change)', async () => {
    const tx: ChainTx = {
      txid: 'tk2',
      version: 4,
      vin: [{ txid: 'prev', vout: 0, prevoutAddress: 'addr-0-0', prevoutValue: 1000n }],
      vout: [
        { value: 0n, scripthash: 'sh1', address: 'EXT-recipient', tokenId: 'tokA', tokenAmount: 5_000_000n, tokenDecimals: 6 },
        { value: 0n, scripthash: 'sh2', address: 'addr-0-0', tokenId: 'tokA', tokenAmount: 10_000_000n, tokenDecimals: 6 }, // token change back to us
        { value: 900n, scripthash: 'sh3', address: 'addr-0-0' }, // native-coin change
      ],
      size: 400,
      fee: 100n,
      status: { confirmed: true, blockHeight: 951 },
    }
    const svc = new ChainService(
      backend({
        infos: { 'addr-0-0': withTokens('addr-0-0', { tokA: 10_000_000n }) },
        txs: { 'addr-0-0': [tx] },
        tokenInfo: { tokA: { id: 'tokA', decimals: 6, symbol: 'Tether USD', name: 'USDT' } },
      }),
      branches,
    )
    const { items } = await svc.getHistory()
    expect(items[0]).toMatchObject({ txid: 'tk2', direction: 'out', tokenId: 'tokA', tokenAmountAtomic: '5000000', tokenTicker: 'USDT' })
  })
})

describe('special transaction types (W1)', () => {
  const baseTx = (over: Partial<ChainTx>): ChainTx => ({
    txid: 't1',
    version: 1,
    vin: [{ txid: 'p', vout: 0, prevoutValue: 100n, prevoutAddress: 'addr-0-0' }],
    vout: [{ value: 40n, scripthash: 'sh', address: 'EXT' }],
    size: 150,
    fee: 60n,
    status: { confirmed: true, blockHeight: 990 },
    ...over,
  })

  it('tags non-standard history rows with their type', async () => {
    const slashing = baseTx({ txid: 's1', version: 5 })
    const svc = new ChainService(
      backend({ infos: { 'addr-0-0': fundedInfo('addr-0-0', 100n) }, txs: { 'addr-0-0': [slashing] } }),
      branches,
    )
    const page = await svc.getHistory()
    expect(page.items[0]).toMatchObject({ txid: 's1', txType: 5 })
  })

  it('leaves standard rows untagged', async () => {
    const standard = baseTx({ txid: 'n1', version: 1 })
    const svc = new ChainService(
      backend({ infos: { 'addr-0-0': fundedInfo('addr-0-0', 100n) }, txs: { 'addr-0-0': [standard] } }),
      branches,
    )
    const page = await svc.getHistory()
    expect(page.items[0]!.txType).toBeUndefined()
  })

  it('carries the raw type name for an id this build does not know', async () => {
    const unknown = baseTx({ txid: 'u1', version: 0, txTypeName: 'wormhole' })
    const svc = new ChainService(backend({ tx: { u1: unknown } }), branches)
    const detail = await svc.getTxDetail('u1')
    expect(detail.txType).toBe(0)
    expect(detail.txTypeName).toBe('wormhole')
  })

  it('threads downgrade info through and decodes the payout address', async () => {
    // P2PKH scriptPubKey for hash160 d986ed…aa → 1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA
    // (the pinned staging golden, so the decode is checked against a known pair).
    const spk = '76a914d986ed01b7a22225a70edbf2ba7cfb63a15cb3aa88ac'
    const downgrade = baseTx({
      txid: 'd7',
      version: 7,
      downgradeInfo: { btcTxid: 'ee'.repeat(32), freezeTxid: 'dd'.repeat(32), freezeVout: 1, btcVout: 0, btcValueSat: 386322n, btcScriptPubKey: spk },
    })
    const svc = new ChainService(backend({ tx: { d7: downgrade } }), branches, { btcNetwork: 'mainnet' })
    const detail = await svc.getTxDetail('d7')
    expect(detail.downgradeInfo).toMatchObject({
      btcTxid: 'ee'.repeat(32),
      freezeTxid: 'dd'.repeat(32),
      freezeVout: 1,
      btcValueSat: '386322',
      btcAddress: '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA',
    })
  })

  it('keeps the raw script when no btc network is configured or it is nonstandard', async () => {
    const burn = baseTx({
      txid: 'b6',
      version: 6,
      downgradeInfo: { btcTxid: 'ee'.repeat(32), btcBlockHash: 'ff'.repeat(32) },
    })
    const svc = new ChainService(backend({ tx: { b6: burn } }), branches)
    const detail = await svc.getTxDetail('b6')
    expect(detail.downgradeInfo).toEqual({ btcTxid: 'ee'.repeat(32), btcBlockHash: 'ff'.repeat(32) })
  })
})
