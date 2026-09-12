import { decodeBtcAddress, masterKeyFromSeed, mnemonicToSeed, toHex, type HDKey } from '@qbtc/crypto'
import type { BtcHistoryTx, BtcUtxo } from '@qbtc/chain'
import { describe, expect, it } from 'vitest'
import { btcStagingPath, deriveBtcStagingAddress } from '../../src/main/wallet/btcStaging'
import { UpgradeService, type UpgradeParams } from '../../src/main/wallet/UpgradeService'

// Standard BIP-39 test mnemonic. The staging branch is plain Bitcoin
// BIP-44 (m/44'/0'/0'/0/i), so index 0 is the FAMOUS reference address —
// pinned here as the recoverability guarantee: any third-party wallet
// restoring this mnemonic as "legacy p2pkh" must land on the same coins.
const MASTER = masterKeyFromSeed(
  mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
)
const ADDR0 = '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA'
const ADDR1 = '1Ak8PffB2meyfYnbXZR9EGfLfFZVpzJvQP'

const LOCK_SCRIPT_HEX = '76a91456ca8180ab9c6f4b9bb8a3d84cddd8567031940788ac'
const PARAMS: UpgradeParams = {
  lockScriptHex: LOCK_SCRIPT_HEX,
  minConvertValue: 10_000n,
  dustLimit: 546n,
  feeTargetBlocks: 6,
  fallbackFeeRate: 2,
}
const DEST32 = new Uint8Array(32).fill(0x29)

function utxo(txid: string, vout: number, value: bigint, confirmed = true): BtcUtxo {
  return { txid, vout, value, confirmed, ...(confirmed ? { blockHeight: 850_000 } : {}) }
}

interface FakeChainState {
  utxosByAddress?: Record<string, BtcUtxo[]>
  txsByAddress?: Record<string, BtcHistoryTx[]>
  fees?: ReadonlyMap<number, number>
  failFees?: boolean
  tip?: number
}

function harness(state: FakeChainState = {}) {
  const broadcasts: string[] = []
  let saved: number | null = null
  const vault = { getMasterKey: async (): Promise<HDKey> => MASTER, on: () => () => {} }
  const store = {
    loadStagingIndex: async () => saved ?? 0,
    saveStagingIndex: async (i: number) => {
      saved = i
    },
  }
  const chain = {
    addressUtxos: async (a: string) => state.utxosByAddress?.[a] ?? [],
    addressTxs: async (a: string) => state.txsByAddress?.[a] ?? [],
    feeEstimates: async () => {
      if (state.failFees === true) throw new Error('oracle down')
      return state.fees ?? new Map([[6, 3]])
    },
    broadcast: async (hex: string) => {
      broadcasts.push(hex)
      return 'ab'.repeat(32)
    },
    tipHeight: async () => state.tip ?? 850_105,
  }
  const service = new UpgradeService(vault, store, chain, PARAMS)
  return { service, broadcasts, savedIndex: () => saved }
}

describe('staging derivation', () => {
  it('index 0 is the standard BIP-44 Bitcoin address of the test mnemonic', () => {
    expect(btcStagingPath(0)).toBe("m/44'/0'/0'/0/0")
    expect(deriveBtcStagingAddress(MASTER, 0, 'mainnet')).toBe(ADDR0)
    expect(deriveBtcStagingAddress(MASTER, 1, 'mainnet')).toBe(ADDR1)
  })

  it('testnet uses the standard BIP-44 testnet branch (coin type 1)', () => {
    // Golden vectors of the test mnemonic at m/44'/1'/0'/0/i — the same
    // addresses Electrum/Sparrow restore in testnet mode.
    expect(btcStagingPath(0, 'testnet')).toBe("m/44'/1'/0'/0/0")
    expect(deriveBtcStagingAddress(MASTER, 0, 'testnet')).toBe('mkpZhYtJu2r87Js3pDiWJDmPte2NRZ8bJV')
    expect(deriveBtcStagingAddress(MASTER, 1, 'testnet')).toBe('mzpbWabUQm1w8ijuJnAof5eiSTep27deVH')
  })
})

describe('status', () => {
  it('splits confirmed and pending balance and reconstructs episodes from chain', async () => {
    const episodeTx: BtcHistoryTx = {
      txid: 'cc'.repeat(32),
      status: { confirmed: true, blockHeight: 850_100 },
      outputs: [
        { scriptPubKeyHex: LOCK_SCRIPT_HEX, value: 4_999_295n },
        { scriptPubKeyHex: `6a20${'29'.repeat(32)}`, value: 0n },
      ],
    }
    const { service } = harness({
      utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 5_000_000n), utxo('bb'.repeat(32), 1, 300_000n, false)] },
      txsByAddress: { [ADDR0]: [episodeTx] },
    })
    const status = await service.status()
    expect(status.stagingAddress).toBe(ADDR0)
    expect(status.confirmedBalance).toBe(5_000_000n)
    expect(status.pendingBalance).toBe(300_000n)
    expect(status.episodes).toHaveLength(1)
    expect(status.episodes[0]).toMatchObject({
      txid: 'cc'.repeat(32),
      lockValue: 4_999_295n,
      destScripthashHex: '29'.repeat(32),
      confirmed: true,
      blockHeight: 850_100,
      confirmations: 6, // tip 850_105 − height 850_100 + 1
    })
  })

  it('an episode without OP_RETURN reports a fallback credit (null dest)', async () => {
    const { service } = harness({
      txsByAddress: {
        [ADDR0]: [
          {
            txid: 'dd'.repeat(32),
            status: { confirmed: false },
            outputs: [{ scriptPubKeyHex: LOCK_SCRIPT_HEX, value: 1_000_000n }],
          },
        ],
      },
    })
    const status = await service.status()
    expect(status.episodes[0]!.destScripthashHex).toBeNull()
    expect(status.episodes[0]!.confirmed).toBe(false)
  })
})

describe('planConvert', () => {
  it('mode all spends everything minus the fee, no change', async () => {
    const { service } = harness({
      utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 5_000_000n), utxo('bb'.repeat(32), 1, 300_000n, false)] },
    })
    const plan = await service.planConvert({ mode: 'all' })
    // 1 confirmed input; size = 10 + 149 + 34 + 43 = 236; fee = 236*3 = 708.
    expect(plan.fee).toBe(708n)
    expect(plan.sendValue).toBe(5_000_000n - 708n)
    expect(plan.changeValue).toBe(0n)
    expect(plan.inputs).toHaveLength(1) // unconfirmed UTXO not spendable
  })

  it('mode amount produces change above dust', async () => {
    const { service } = harness({
      utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 3_500_000n), utxo('bb'.repeat(32), 1, 1_500_000n)] },
    })
    const plan = await service.planConvert({ mode: 'amount', amountSat: 3_000_000n })
    // 2 inputs, 3 outputs: size = 10 + 298 + 34 + 43 + 34 = 419; fee = 1257.
    expect(plan.fee).toBe(1257n)
    expect(plan.changeValue).toBe(5_000_000n - 3_000_000n - 1257n)
    expect(plan.foldedChange).toBe(false)
  })

  it('folds a sub-dust remainder into the fee', async () => {
    // fee with change at 3 sat/vB = (10 + 149 + 34 + 43 + 34) * 3 = 810;
    // remainder = 3_001_200 − 3_000_000 − 810 = 390 ≤ dust → folded.
    const { service } = harness({
      utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 3_001_200n)] },
    })
    const plan = await service.planConvert({ mode: 'amount', amountSat: 3_000_000n })
    expect(plan.changeValue).toBe(0n)
    expect(plan.foldedChange).toBe(true)
    expect(plan.fee).toBe(1_200n) // the whole remainder
  })

  it('enforces the minimum and the balance', async () => {
    const { service } = harness({ utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 50_000n)] } })
    await expect(service.planConvert({ mode: 'amount', amountSat: 9_999n })).rejects.toThrow(/minimum/)
    await expect(service.planConvert({ mode: 'amount', amountSat: 60_000n })).rejects.toThrow(/Insufficient/)
  })

  it('falls back to the configured fee rate when the oracle fails', async () => {
    const { service } = harness({
      utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 5_000_000n)] },
      failFees: true,
    })
    const plan = await service.planConvert({ mode: 'all' })
    expect(plan.feeRate).toBe(2)
  })
})

describe('convert', () => {
  it('broadcasts a spend paying the lock script and the OP_RETURN commitment', async () => {
    const { service, broadcasts, savedIndex } = harness({
      utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 5_000_000n)] },
    })
    const { txid, plan } = await service.convert({ mode: 'all' }, DEST32)
    expect(txid).toBe('ab'.repeat(32))
    expect(broadcasts).toHaveLength(1)
    const hex = broadcasts[0]!
    expect(hex.startsWith('02000000')).toBe(true)
    expect(hex).toContain(LOCK_SCRIPT_HEX)
    expect(hex).toContain(`6a20${'29'.repeat(32)}`)
    expect(plan.changeValue).toBe(0n)
    expect(savedIndex()).toBeNull() // no change → the episode key keeps the index
  })

  it('partial conversion sends change to the NEXT staging index and persists it', async () => {
    const { service, broadcasts, savedIndex } = harness({
      utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 5_000_000n)] },
    })
    await service.convert({ mode: 'amount', amountSat: 3_000_000n }, DEST32)
    // change must pay ADDR1's P2PKH script (index 1)
    const changeScriptHex = toHex(decodeBtcAddress(ADDR1, 'mainnet').scriptPubKey)
    expect(broadcasts[0]!).toContain(changeScriptHex)
    expect(savedIndex()).toBe(1)
    const next = await service.stagingAddress()
    expect(next.address).toBe(ADDR1)
  })

  it('rejects a bad destination scripthash length', async () => {
    const { service } = harness({ utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 5_000_000n)] } })
    await expect(service.convert({ mode: 'all' }, new Uint8Array(21))).rejects.toThrow(/20 or 32/)
  })
})

describe('returnAll', () => {
  it('sends the whole balance to a decoded arbitrary address (bech32 v0)', async () => {
    const { service, broadcasts } = harness({
      utxosByAddress: { [ADDR0]: [utxo('aa'.repeat(32), 0, 1_000_000n)] },
    })
    const res = await service.returnAll('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    expect(res.value + res.fee).toBe(1_000_000n)
    expect(broadcasts[0]!).toContain('0014751e76e8199196d454941c45d1b3a323f1433bd6')
  })

  it('refuses when there is nothing to return', async () => {
    const { service } = harness()
    await expect(service.returnAll(ADDR1)).rejects.toThrow(/Nothing to return/)
  })
})
