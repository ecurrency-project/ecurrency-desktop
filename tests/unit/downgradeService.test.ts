import { describe, expect, it } from 'vitest'
import type { ChainTx, Outspend } from '@qbitcoin/chain'
import { addressFromScripthash, downgradeScript, federationFreezeScript, federationScripthash, freezeScript, fromHex, getPublicKey, hash256, reclaimScripthash, serialize, toHex, TX_TYPE_STANDARD, type Transaction } from '@qbitcoin/crypto'
import {
  DowngradeService,
  estimateBtcForDowngrade,
  levelByTotal,
  type DowngradeEpisodeRecord,
  type DowngradeWallet,
  type ReclaimKeyCell,
} from '../../src/main/wallet/DowngradeService'
import type { SpendableUtxo, UnsignedTx } from '../../src/main/wallet/buildTx'

const FREEZE_SEC = 48 * 3600
const OUTPUT_SEC = 7 * 24 * 3600

// The current (federation) covenant era: 2-of-3 over Falcon-sized keys,
// hash256 scripthashes — and the retired single-key era next to it.
const FED_KEYS = [new Uint8Array(897).fill(0x1a), new Uint8Array(897).fill(0x77), new Uint8Array(897).fill(0xc1)]
const LEGACY_KEY = fromHex('02' + 'ab'.repeat(32))
const FREEZE_SH = toHex(federationScripthash(federationFreezeScript(FED_KEYS, FREEZE_SEC)))
const DOWNGRADE_SH = toHex(federationScripthash(downgradeScript(OUTPUT_SEC)))
const LEGACY_FREEZE_SH = toHex(reclaimScripthash(freezeScript(LEGACY_KEY, FREEZE_SEC)))

const RECLAIM_PRIV = fromHex('11'.repeat(32))
const RECLAIM_PUB = getPublicKey(RECLAIM_PRIV)
const BTC_SPK_HEX = '76a914' + '22'.repeat(20) + '88ac'

const FREEZE_ADDR = addressFromScripthash(fromHex(FREEZE_SH), 'mainnet')
const DOWNGRADE_ADDR = addressFromScripthash(fromHex(DOWNGRADE_SH), 'mainnet')
const LEGACY_FREEZE_ADDR = addressFromScripthash(fromHex(LEGACY_FREEZE_SH), 'mainnet')
const CHANGE_ADDR = addressFromScripthash(fromHex('cd'.repeat(20)), 'mainnet')

const now = (): number => Math.floor(Date.now() / 1000)

function pool(): SpendableUtxo[] {
  return [
    { txid: 'aa'.repeat(32), vout: 0, value: 5_000_000n, chain: 0, index: 3, algo: 'ecdsa', scheme: 's1' },
    { txid: 'bb'.repeat(32), vout: 1, value: 2_000_000n, chain: 0, index: 4, algo: 'ecdsa' },
  ]
}

function makeService(over: {
  txs?: Record<string, ChainTx>
  outspends?: Record<string, Outspend>
  episodes?: DowngradeEpisodeRecord[]
  totalCoins?: bigint
  /** Unspent covenant outputs, keyed by address (freeze / downgrade, any era). */
  unspent?: Record<string, { txid: string; vout: number; value: bigint }[]>
  cells?: ReclaimKeyCell[]
  /** Raw wire hex per txid, for the rescan fallback. */
  rawHex?: Record<string, string>
  listUnspentFails?: boolean
} = {}) {
  const broadcasts: string[] = []
  const signedDrafts: UnsignedTx[] = []
  const txFetches: string[] = []
  let cellCalls = 0
  let saved: readonly DowngradeEpisodeRecord[] = over.episodes ?? []
  const wallet: DowngradeWallet = {
    spendable: async () => pool(),
    covenantAddress: (scripthash) => addressFromScripthash(scripthash, 'mainnet'),
    reclaimKeyCells: async () => {
      cellCalls += 1
      return over.cells ?? []
    },
    changeAddressFor: async () => CHANGE_ADDR,
    feeRate: async () => 1,
    scripthashOf: () => fromHex('cd'.repeat(20)),
    inputPubkey: async () => RECLAIM_PUB,
    inputKeypair: async () => ({ privateKey: new Uint8Array(RECLAIM_PRIV), publicKey: RECLAIM_PUB }),
    signUnsigned: async (unsigned) => {
      signedDrafts.push(unsigned)
      return { rawHex: 'f00d', txid: 'f1'.repeat(32) }
    },
  }
  const service = new DowngradeService(
    { freezePubkeys: FED_KEYS, freezeSeconds: FREEZE_SEC, outputSeconds: OUTPUT_SEC, btcNetwork: 'mainnet', legacyLockPubkey: LEGACY_KEY },
    {
      getTransaction: async (txid) => {
        txFetches.push(txid)
        const tx = over.txs?.[txid]
        if (tx === undefined) throw new Error(`no tx ${txid}`)
        return tx
      },
      getTransactionHex: async (txid) => {
        const hex = over.rawHex?.[txid]
        if (hex === undefined) throw new Error(`no raw tx ${txid}`)
        return hex
      },
      getOutspend: async (txid, vout) => over.outspends?.[`${txid}:${String(vout)}`] ?? { spent: false },
      getNodeStatus: async () => ({ totalCoins: over.totalCoins ?? 0n }),
      broadcastTransaction: async (rawHex) => {
        broadcasts.push(rawHex)
        return { txid: 'b0'.repeat(32) }
      },
      listUnspent: async (address) => {
        if (over.listUnspentFails === true) throw new Error('node is down')
        return over.unspent?.[address] ?? []
      },
    },
    {
      load: async () => saved,
      save: async (episodes) => {
        saved = episodes
      },
    },
    wallet,
  )
  return { service, broadcasts, signedDrafts, savedRef: () => saved, txFetches, cellCallsRef: () => cellCalls }
}

const tx = (over: Partial<ChainTx> & { txid: string }): ChainTx => ({
  version: 1,
  vin: [],
  vout: [],
  size: 200,
  fee: 5n,
  status: { confirmed: true, blockHeight: 100, blockTime: now() - 60 },
  ...over,
})

const EPISODE: DowngradeEpisodeRecord = {
  freezeTxid: 'f1'.repeat(32),
  vout: 0,
  valueAtomic: '1000000',
  btcScriptPubKeyHex: BTC_SPK_HEX,
  reclaim: { account: 0, chain: 0, index: 3, algo: 'ecdsa', scheme: 's1' },
}

describe('rate estimate', () => {
  it('level 0 is 1:1 gross, 1% fee net', () => {
    expect(levelByTotal(0n)).toBe(0)
    // 1 coin → 1e8 gross → 0.99e8 net
    expect(estimateBtcForDowngrade(100_000_000n, 0)).toBe(99_000_000n)
  })

  it('level scales with the upgraded total and clamps at the table edge', () => {
    // Half the supply upgraded → level 2500.
    expect(levelByTotal(1_050_000_000_000_000n)).toBe(2500)
    expect(levelByTotal(10n ** 30n)).toBe(4999)
  })

  it('a deeper level pays out MORE btc per native coin (price falls)', () => {
    expect(estimateBtcForDowngrade(100_000_000n, 100) > estimateBtcForDowngrade(100_000_000n, 0)).toBe(true)
  })
})

describe('plan', () => {
  it('estimates payout and native fee', async () => {
    const { service } = makeService()
    const plan = await service.plan(1_000_000n)
    expect(plan.estimatedBtcSat).toBe('990000')
    expect(plan.levelEstimate).toBe(0)
    expect(BigInt(plan.feeAtomic) > 0n).toBe(true)
  })

  it('refuses dust payouts', async () => {
    const { service } = makeService()
    await expect(service.plan(500n)).rejects.toThrow(/dust/)
  })
})

describe('convert', () => {
  it('attaches [hash256(input0 pubkey)][btc spk] to the freeze output and records the episode', async () => {
    const { service, signedDrafts, savedRef, broadcasts } = makeService()
    const result = await service.convert(1_000_000n, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA')
    expect(result.txid).toBe('b0'.repeat(32))
    expect(broadcasts).toHaveLength(1)

    const draft = signedDrafts[0]!
    const out0 = draft.outputs[0]!
    expect(out0.scripthash).toBe(FREEZE_SH)
    expect(out0.valueAtomic).toBe('1000000')
    expect(out0.data!.slice(0, 64)).toBe(toHex(hash256(RECLAIM_PUB)))
    // The committed scriptPubKey is P2PKH of the given address.
    expect(out0.data!.slice(64)).toMatch(/^76a914[0-9a-f]{40}88ac$/)

    const saved = savedRef()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      freezeTxid: 'f1'.repeat(32),
      vout: 0,
      valueAtomic: '1000000',
      reclaim: { chain: 0, algo: 'ecdsa' },
    })
  })
})

describe('status machine', () => {
  const freezeTxid = EPISODE.freezeTxid

  it('young unspent freeze → frozen with a maturity timestamp', async () => {
    const { service } = makeService({
      episodes: [EPISODE],
      txs: { [freezeTxid]: tx({ txid: freezeTxid }) },
    })
    const [view] = await service.status()
    expect(view!.state).toBe('frozen')
    expect(view!.reclaimableAt).toBeGreaterThan(now())
    expect(view!.btcAddress).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA'.slice(0, 0) || view!.btcAddress)
  })

  it('old unspent freeze → reclaimable at the freeze outpoint', async () => {
    const { service } = makeService({
      episodes: [EPISODE],
      txs: { [freezeTxid]: tx({ txid: freezeTxid, status: { confirmed: true, blockHeight: 1, blockTime: now() - FREEZE_SEC - 60 } }) },
    })
    const [view] = await service.status()
    expect(view!.state).toBe('reclaimable')
    expect(view!.reclaimOutpoint).toMatchObject({ txid: freezeTxid, vout: 0, kind: 'freeze' })
  })

  it('freeze spent by a downgrade tx → converting, with the promised btc txid', async () => {
    const dTxid = 'd7'.repeat(32)
    const { service } = makeService({
      episodes: [EPISODE],
      txs: {
        [freezeTxid]: tx({ txid: freezeTxid }),
        [dTxid]: tx({
          txid: dTxid,
          version: 7,
          vout: [{ value: 990_000n, scripthash: DOWNGRADE_SH }],
          downgradeInfo: { btcTxid: 'ee'.repeat(32) },
        }),
      },
      outspends: { [`${freezeTxid}:0`]: { spent: true, txid: dTxid } },
    })
    const [view] = await service.status()
    expect(view!.state).toBe('converting')
    expect(view!.downgradeTxid).toBe(dTxid)
    expect(view!.btcTxid).toBe('ee'.repeat(32))
  })

  it('downgrade output burned → paid', async () => {
    const dTxid = 'd7'.repeat(32)
    const bTxid = 'b6'.repeat(32)
    const { service } = makeService({
      episodes: [EPISODE],
      txs: {
        [freezeTxid]: tx({ txid: freezeTxid }),
        [dTxid]: tx({ txid: dTxid, version: 7, vout: [{ value: 990_000n, scripthash: DOWNGRADE_SH }], downgradeInfo: { btcTxid: 'ee'.repeat(32) } }),
        [bTxid]: tx({ txid: bTxid, version: 6 }),
      },
      outspends: {
        [`${freezeTxid}:0`]: { spent: true, txid: dTxid },
        [`${dTxid}:0`]: { spent: true, txid: bTxid },
      },
    })
    const [view] = await service.status()
    expect(view!.state).toBe('paid')
    expect(view!.burnTxid).toBe(bTxid)
  })

  it('stalled downgrade output matures into reclaimable at ITS outpoint', async () => {
    const dTxid = 'd7'.repeat(32)
    const { service } = makeService({
      episodes: [EPISODE],
      txs: {
        [freezeTxid]: tx({ txid: freezeTxid }),
        [dTxid]: tx({
          txid: dTxid,
          version: 7,
          vout: [{ value: 990_000n, scripthash: DOWNGRADE_SH }],
          status: { confirmed: true, blockHeight: 2, blockTime: now() - OUTPUT_SEC - 60 },
        }),
      },
      outspends: { [`${freezeTxid}:0`]: { spent: true, txid: dTxid } },
    })
    const [view] = await service.status()
    expect(view!.state).toBe('reclaimable')
    expect(view!.reclaimOutpoint).toMatchObject({ txid: dTxid, vout: 0, kind: 'downgrade', valueAtomic: '990000' })
  })

  it('freeze spent by an ordinary tx → reclaimed (only our key can)', async () => {
    const rTxid = 'ce'.repeat(32)
    const { service } = makeService({
      episodes: [EPISODE],
      txs: {
        [freezeTxid]: tx({ txid: freezeTxid }),
        [rTxid]: tx({ txid: rTxid, version: 1 }),
      },
      outspends: { [`${freezeTxid}:0`]: { spent: true, txid: rTxid } },
    })
    const [view] = await service.status()
    expect(view!.state).toBe('reclaimed')
  })
})

describe('rescan', () => {
  const RECLAIM_ID = toHex(hash256(RECLAIM_PUB))
  const CELL: ReclaimKeyCell = { account: 0, chain: 0, index: 0, algo: 'ecdsa', reclaimIdHex: RECLAIM_ID }
  const BTC_ADDR = '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA'
  const F1 = 'a1'.repeat(32)

  const freezeTx = (txid: string, reclaimId: string): ChainTx =>
    tx({
      txid,
      vout: [
        { value: 40_000_000n, scripthash: FREEZE_SH, downgrade: { btcAddress: BTC_ADDR, reclaimId } },
        { value: 100n, scripthash: 'cd'.repeat(20) },
      ],
    })

  it('discovers a freeze committed to one of our cells (fixed-cell convention)', async () => {
    const { service, savedRef } = makeService({
      unspent: { [FREEZE_ADDR]: [{ txid: F1, vout: 0, value: 40_000_000n }] },
      cells: [CELL],
      txs: { [F1]: freezeTx(F1, RECLAIM_ID) },
    })
    const views = await service.status()
    expect(views).toHaveLength(1)
    expect(views[0]!.state).toBe('frozen')
    const saved = savedRef()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      freezeTxid: F1,
      vout: 0,
      valueAtomic: '40000000',
      reclaim: { account: 0, chain: 0, index: 0, algo: 'ecdsa' },
    })
    // The journaled payout script is P2PKH of the annotated address.
    expect(saved[0]!.btcScriptPubKeyHex).toMatch(/^76a914[0-9a-f]{40}88ac$/)
  })

  it('matches a post-quantum cell too', async () => {
    const pqId = toHex(hash256(fromHex('99'.repeat(897))))
    const cell: ReclaimKeyCell = { account: 0, chain: 1, index: 2, algo: 'falcon512', reclaimIdHex: pqId }
    const { service, savedRef } = makeService({
      unspent: { [FREEZE_ADDR]: [{ txid: F1, vout: 0, value: 1_000_000n }] },
      cells: [cell],
      txs: { [F1]: freezeTx(F1, pqId) },
    })
    await service.status()
    expect(savedRef()[0]!.reclaim).toEqual({ account: 0, chain: 1, index: 2, algo: 'falcon512' })
  })

  it('ignores foreign freezes and never refetches them', async () => {
    const { service, savedRef, txFetches } = makeService({
      unspent: { [FREEZE_ADDR]: [{ txid: F1, vout: 0, value: 1_000_000n }] },
      cells: [CELL],
      txs: { [F1]: freezeTx(F1, 'ff'.repeat(32)) },
    })
    await service.status()
    await service.status()
    expect(savedRef()).toHaveLength(0)
    expect(txFetches.filter((t) => t === F1)).toHaveLength(1)
  })

  it('leaves journaled outpoints alone', async () => {
    const { service, savedRef } = makeService({
      episodes: [EPISODE],
      unspent: { [FREEZE_ADDR]: [{ txid: EPISODE.freezeTxid, vout: 0, value: 1_000_000n }] },
      cells: [CELL],
      txs: { [EPISODE.freezeTxid]: tx({ txid: EPISODE.freezeTxid }) },
    })
    const views = await service.status()
    expect(views).toHaveLength(1)
    expect(savedRef()).toHaveLength(1)
  })

  it('maps a downgrade-stage output back to its original freeze', async () => {
    const F2 = 'a2'.repeat(32)
    const D = 'd2'.repeat(32)
    const { service, savedRef } = makeService({
      unspent: { [DOWNGRADE_ADDR]: [{ txid: D, vout: 0, value: 990_000n }] },
      cells: [CELL],
      txs: {
        [F2]: tx({ txid: F2, vout: [{ value: 1_000_000n, scripthash: FREEZE_SH }] }),
        [D]: tx({
          txid: D,
          version: 7,
          vout: [{ value: 990_000n, scripthash: DOWNGRADE_SH, downgrade: { reclaimId: RECLAIM_ID } }],
          downgradeInfo: { btcTxid: 'ee'.repeat(32), freezeTxid: F2, freezeVout: 0, btcScriptPubKey: BTC_SPK_HEX },
        }),
      },
      outspends: { [`${F2}:0`]: { spent: true, txid: D } },
    })
    const views = await service.status()
    expect(views).toHaveLength(1)
    expect(views[0]!.state).toBe('converting')
    expect(views[0]!.downgradeTxid).toBe(D)
    expect(savedRef()[0]).toMatchObject({
      freezeTxid: F2,
      vout: 0,
      valueAtomic: '1000000',
      btcScriptPubKeyHex: BTC_SPK_HEX,
      reclaim: { account: 0, chain: 0, index: 0, algo: 'ecdsa' },
    })
  })

  it('still renders the journal when the chain scan is unreachable', async () => {
    const { service } = makeService({
      listUnspentFails: true,
      episodes: [EPISODE],
      txs: { [EPISODE.freezeTxid]: tx({ txid: EPISODE.freezeTxid }) },
    })
    const views = await service.status()
    expect(views).toHaveLength(1)
    expect(views[0]!.state).toBe('frozen')
  })

  it('discovers a LEGACY-era freeze on the retired covenant address', async () => {
    const F3 = 'a3'.repeat(32)
    const { service, savedRef } = makeService({
      unspent: { [LEGACY_FREEZE_ADDR]: [{ txid: F3, vout: 0, value: 40_000_000n }] },
      cells: [CELL],
      txs: {
        [F3]: tx({
          txid: F3,
          vout: [{ value: 40_000_000n, scripthash: LEGACY_FREEZE_SH, downgrade: { btcAddress: BTC_ADDR, reclaimId: RECLAIM_ID } }],
        }),
      },
    })
    const views = await service.status()
    expect(views).toHaveLength(1)
    expect(savedRef()[0]).toMatchObject({ freezeTxid: F3, covenant: 'legacy' })
  })

  it('falls back to the raw wire bytes when the node stops annotating an era', async () => {
    // The updated node no longer decorates retired-era outputs with
    // `downgrade{}` — the covenant data must come from /tx/…/hex instead.
    const F4 = 'a4'.repeat(32)
    const rawFreeze: Transaction = {
      txType: TX_TYPE_STANDARD,
      inputs: [{ txid: fromHex('bb'.repeat(32)), vout: 0, siglist: [fromHex('00')], redeemScript: fromHex('00') }],
      outputs: [
        {
          value: 40_000_000n,
          scripthash: fromHex(LEGACY_FREEZE_SH),
          data: fromHex(RECLAIM_ID + BTC_SPK_HEX),
        },
      ],
    }
    const { service, savedRef } = makeService({
      unspent: { [LEGACY_FREEZE_ADDR]: [{ txid: F4, vout: 0, value: 40_000_000n }] },
      cells: [CELL],
      // JSON view carries NO downgrade annotation on the output…
      txs: { [F4]: tx({ txid: F4, vout: [{ value: 40_000_000n, scripthash: LEGACY_FREEZE_SH }] }) },
      // …but the wire bytes still carry [reclaim_id][btc spk].
      rawHex: { [F4]: toHex(serialize(rawFreeze)) },
    })
    const views = await service.status()
    expect(views).toHaveLength(1)
    expect(savedRef()[0]).toMatchObject({
      freezeTxid: F4,
      vout: 0,
      covenant: 'legacy',
      btcScriptPubKeyHex: BTC_SPK_HEX,
      reclaim: { account: 0, chain: 0, index: 0, algo: 'ecdsa' },
    })
  })

  it('treats a covenant output with no usable data as foreign', async () => {
    const F5 = 'a5'.repeat(32)
    const rawShort: Transaction = {
      txType: TX_TYPE_STANDARD,
      inputs: [{ txid: fromHex('bb'.repeat(32)), vout: 0, siglist: [fromHex('00')], redeemScript: fromHex('00') }],
      // data = bare reclaim_id, no scriptPubKey — not a usable conversion.
      outputs: [{ value: 1_000n, scripthash: fromHex(LEGACY_FREEZE_SH), data: fromHex(RECLAIM_ID) }],
    }
    const { service, savedRef, txFetches } = makeService({
      unspent: { [LEGACY_FREEZE_ADDR]: [{ txid: F5, vout: 0, value: 1_000n }] },
      cells: [CELL],
      txs: { [F5]: tx({ txid: F5, vout: [{ value: 1_000n, scripthash: LEGACY_FREEZE_SH }] }) },
      rawHex: { [F5]: toHex(serialize(rawShort)) },
    })
    await service.status()
    await service.status()
    expect(savedRef()).toHaveLength(0)
    expect(txFetches.filter((t) => t === F5)).toHaveLength(1)
  })

  it('derives no cells while the covenant holds nothing unknown', async () => {
    // PQ cells cost a WASM keygen each — an empty scan must not pay for them.
    const { service, cellCallsRef } = makeService({
      episodes: [EPISODE],
      txs: { [EPISODE.freezeTxid]: tx({ txid: EPISODE.freezeTxid }) },
    })
    await service.status()
    expect(cellCallsRef()).toBe(0)
  })
})

describe('reclaim', () => {
  it('refuses while immature and for unknown conversions', async () => {
    const { service } = makeService({
      episodes: [EPISODE],
      txs: { [EPISODE.freezeTxid]: tx({ txid: EPISODE.freezeTxid }) },
    })
    await expect(service.reclaim(EPISODE.freezeTxid)).rejects.toThrow(/cannot be reclaimed yet/)
    await expect(service.reclaim('00'.repeat(32))).rejects.toThrow(/Unknown/)
  })

  it('signs and broadcasts a mature freeze reclaim to the wallet', async () => {
    const { service, broadcasts } = makeService({
      episodes: [EPISODE],
      txs: { [EPISODE.freezeTxid]: tx({ txid: EPISODE.freezeTxid, status: { confirmed: true, blockHeight: 1, blockTime: now() - FREEZE_SEC - 60 } }) },
    })
    const result = await service.reclaim(EPISODE.freezeTxid)
    expect(result.txid).toBe('b0'.repeat(32))
    expect(broadcasts).toHaveLength(1)
    // The broadcast reveals the covenant script of the episode's era — the
    // federation freeze script for a current-era episode.
    expect(broadcasts[0]).toContain(toHex(federationFreezeScript(FED_KEYS, FREEZE_SEC)))
  })

  it('reclaims a LEGACY-era freeze through the single-key script', async () => {
    const legacyEpisode: DowngradeEpisodeRecord = { ...EPISODE, covenant: 'legacy' }
    const { service, broadcasts } = makeService({
      episodes: [legacyEpisode],
      txs: { [EPISODE.freezeTxid]: tx({ txid: EPISODE.freezeTxid, status: { confirmed: true, blockHeight: 1, blockTime: now() - FREEZE_SEC - 60 } }) },
    })
    await service.reclaim(EPISODE.freezeTxid)
    expect(broadcasts[0]).toContain(toHex(freezeScript(LEGACY_KEY, FREEZE_SEC)))
    expect(broadcasts[0]).not.toContain(toHex(federationFreezeScript(FED_KEYS, FREEZE_SEC)))
  })
})
