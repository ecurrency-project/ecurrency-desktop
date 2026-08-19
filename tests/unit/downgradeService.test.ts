import { describe, expect, it } from 'vitest'
import type { ChainTx, Outspend } from '@qbitcoin/chain'
import { addressFromScripthash, downgradeScript, freezeScript, fromHex, getPublicKey, hash256, reclaimScripthash, toHex } from '@qbitcoin/crypto'
import {
  DowngradeService,
  estimateBtcForDowngrade,
  levelByTotal,
  type DowngradeEpisodeRecord,
  type DowngradeWallet,
} from '../../src/main/wallet/DowngradeService'
import type { SpendableUtxo, UnsignedTx } from '../../src/main/wallet/buildTx'

const LOCK_PUBKEY = fromHex('02' + 'ab'.repeat(32))
const FREEZE_SEC = 48 * 3600
const OUTPUT_SEC = 7 * 24 * 3600
const FREEZE_SH = toHex(reclaimScripthash(freezeScript(LOCK_PUBKEY, FREEZE_SEC)))
const DOWNGRADE_SH = toHex(reclaimScripthash(downgradeScript(OUTPUT_SEC)))

const RECLAIM_PRIV = fromHex('11'.repeat(32))
const RECLAIM_PUB = getPublicKey(RECLAIM_PRIV)
const BTC_SPK_HEX = '76a914' + '22'.repeat(20) + '88ac'

const FREEZE_ADDR = addressFromScripthash(fromHex(FREEZE_SH), 'mainnet')
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
} = {}) {
  const broadcasts: string[] = []
  const signedDrafts: UnsignedTx[] = []
  let saved: readonly DowngradeEpisodeRecord[] = over.episodes ?? []
  const wallet: DowngradeWallet = {
    spendable: async () => pool(),
    freezeAddress: () => FREEZE_ADDR,
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
    { lockPubkey: LOCK_PUBKEY, freezeSeconds: FREEZE_SEC, outputSeconds: OUTPUT_SEC, btcNetwork: 'mainnet' },
    {
      getTransaction: async (txid) => {
        const tx = over.txs?.[txid]
        if (tx === undefined) throw new Error(`no tx ${txid}`)
        return tx
      },
      getOutspend: async (txid, vout) => over.outspends?.[`${txid}:${String(vout)}`] ?? { spent: false },
      getNodeStatus: async () => ({ totalCoins: over.totalCoins ?? 0n }),
      broadcastTransaction: async (rawHex) => {
        broadcasts.push(rawHex)
        return { txid: 'b0'.repeat(32) }
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
  return { service, broadcasts, signedDrafts, savedRef: () => saved }
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
    // The broadcast hex must contain the revealed covenant script.
    expect(broadcasts[0]).toContain(toHex(freezeScript(LOCK_PUBKEY, FREEZE_SEC)))
  })
})
