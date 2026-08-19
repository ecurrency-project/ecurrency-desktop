import type { ChainTx, Outspend } from '@qbitcoin/chain'
import {
  btcAddressFromScriptPubKey,
  buildFreezeOutput,
  decodeBtcAddress,
  downgradeScript,
  freezeScript,
  reclaimScripthash,
  signReclaimInput,
  toHex,
  fromHex,
  serialize,
  txid as computeTxid,
  TX_TYPE_STANDARD,
  type BtcNetwork,
  type Transaction,
} from '@qbitcoin/crypto'
import { buildSend, estimateSendFee, feeForInputs, type BuiltSend, type SpendableUtxo, type UnsignedTx } from './buildTx'
import type { SignedTx } from './signTx'

// The native→BTC downgrade, user side. Three jobs:
//
//   1. CONVERT: pay the requested sum into a freeze output — a standard
//      transaction whose first output pays the freeze scripthash and whose
//      data commits [hash256(pubkey of input 0)][BTC scriptPubKey to pay].
//      The conversion service picks it up from there.
//   2. STATUS: walk each episode down the chain — freeze → (spent by) the
//      service's downgrade tx → (spent by) the burn that proves the BTC
//      payment — and surface where it stands, including when a stalled
//      output has matured into reclaimability.
//   3. RECLAIM: spend a matured freeze/downgrade output back to the wallet
//      through the covenant's ELSE branch.
//
// The BTC amount shown by plan() is an ESTIMATE: the level-based rate is
// fixed by the node when the downgrade transaction confirms, and the level
// here derives from the node's total_coins, which approximates the upgraded
// total. The estimate is labelled "≈" in the UI and never signed.

/** Consensus parameters (brand values, from DOWNGRADE in @qbitcoin/crypto). */
export interface DowngradeParams {
  readonly lockPubkey: Uint8Array
  readonly freezeSeconds: number
  readonly outputSeconds: number
  readonly btcNetwork: BtcNetwork
}

/** Chain reads the service needs; ChainClient satisfies it, tests fake it. */
export interface DowngradeChainReader {
  getTransaction(txid: string): Promise<ChainTx>
  getOutspend(txid: string, vout: number): Promise<Outspend>
  getNodeStatus(): Promise<{ totalCoins?: bigint }>
  broadcastTransaction(rawHex: string): Promise<{ txid: string }>
}

/** One recorded conversion (persisted sealed; the chain is the source of
 *  truth for its state, this is just which outpoints are ours). */
export interface DowngradeEpisodeRecord {
  readonly freezeTxid: string
  readonly vout: number
  readonly valueAtomic: string
  readonly btcScriptPubKeyHex: string
  /** Derivation of the reclaim key (the freeze tx's input 0). */
  readonly reclaim: {
    readonly account: number
    readonly chain: 0 | 1
    readonly index: number
    readonly algo: 'ecdsa' | 'falcon512'
    readonly scheme?: string
  }
}

export interface DowngradeStore {
  load(): Promise<readonly DowngradeEpisodeRecord[]>
  save(episodes: readonly DowngradeEpisodeRecord[]): Promise<void>
}

/** Wallet capabilities the service borrows from the session (main only). */
export interface DowngradeWallet {
  /** Spendable pool for coin selection (native, unfrozen). */
  spendable(): Promise<readonly SpendableUtxo[]>
  /** The freeze address (the freeze scripthash, address-encoded) — buildSend
   *  decodes it back; keeps the service off the address codec. */
  freezeAddress(): string
  /** Fresh change / reclaim destination for a branch. */
  changeAddressFor(algo: 'ecdsa' | 'falcon512'): Promise<string>
  /** Fee rate in atomic units per vByte. */
  feeRate(): Promise<number>
  /** Decode any of OUR addresses to its scripthash (reclaim destination). */
  scripthashOf(address: string): Uint8Array
  /** Public key of an unsigned input (derived on its own branch + scheme). */
  inputPubkey(input: { account: number; chain: 0 | 1; index: number; algo: 'ecdsa' | 'falcon512'; scheme?: string }): Promise<Uint8Array>
  /** Private key material for the same derivation (reclaim signing). Caller
   *  wipes it after use. */
  inputKeypair(input: { account: number; chain: 0 | 1; index: number; algo: 'ecdsa' | 'falcon512'; scheme?: string }): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }>
  /** Sign an unsigned draft (ordinary inputs) and serialize. */
  signUnsigned(unsigned: UnsignedTx): Promise<SignedTx>
}

export type DowngradeEpisodeState = 'frozen' | 'reclaimable' | 'converting' | 'paid' | 'reclaimed'

export interface DowngradeEpisodeView {
  readonly freezeTxid: string
  readonly vout: number
  readonly valueAtomic: string
  readonly btcAddress?: string
  readonly state: DowngradeEpisodeState
  /** Which outpoint a reclaim would spend (freeze, or the downgrade output). */
  readonly reclaimOutpoint?: { txid: string; vout: number; valueAtomic: string; kind: 'freeze' | 'downgrade' }
  /** Epoch seconds when the current stage becomes reclaimable (absent once it is). */
  readonly reclaimableAt?: number
  readonly downgradeTxid?: string
  readonly burnTxid?: string
  /** BTC payout txid (display order), once the service committed to it. */
  readonly btcTxid?: string
}

export interface DowngradePlan {
  readonly amountAtomic: string
  readonly feeAtomic: string
  /** Estimated NET BTC the user receives (after the protocol's service fee). */
  readonly estimatedBtcSat: string
  /** Level the estimate used (display only; the node fixes the real one). */
  readonly levelEstimate: number
}

// Consensus math for the estimate. MAX_VALUE = 21M coins; the level walks a
// 5000-step 0.999^n price curve. price is int(1e6 * 0.999^level) — the node
// generated its lookup table with exactly this expression, so recomputing is
// faithful to well within display precision.
const MAX_VALUE = 2_100_000_000_000_000n
const DOWNGRADE_FEE_PERMIL = 990n // 1% service fee

export function levelByTotal(total: bigint): number {
  const level = Number((total * 5000n) / MAX_VALUE)
  return level < 0 ? 0 : level > 4999 ? 4999 : level
}

export function estimateBtcForDowngrade(valueAtomic: bigint, level: number): bigint {
  const price = BigInt(Math.trunc(1_000_000 * Math.pow(0.999, level)))
  const gross = (valueAtomic * 1_000_000n) / price
  return (gross * DOWNGRADE_FEE_PERMIL) / 1000n
}

/** BTC dust: a payout below this cannot be paid out at all. */
const BTC_DUST_SAT = 546n

export class DowngradeService {
  constructor(
    private readonly params: DowngradeParams,
    private readonly reader: DowngradeChainReader,
    private readonly store: DowngradeStore,
    private readonly wallet: DowngradeWallet,
  ) {}

  /** Estimate what a conversion of `amountAtomic` yields. Throws when the
   *  resulting payout would be dust (economically unconvertible). */
  async plan(amountAtomic: bigint): Promise<DowngradePlan> {
    if (amountAtomic <= 0n) throw new Error('Enter a positive amount.')
    const status = await this.reader.getNodeStatus().catch(() => ({}) as { totalCoins?: bigint })
    const level = levelByTotal(status.totalCoins ?? 0n)
    const estimated = estimateBtcForDowngrade(amountAtomic, level)
    if (estimated <= BTC_DUST_SAT) {
      throw new Error('Amount too small: the BTC payout would be dust.')
    }
    const utxos = await this.wallet.spendable()
    const draft = await this.buildFreezeDraft(utxos, amountAtomic)
    return {
      amountAtomic: amountAtomic.toString(),
      feeAtomic: draft.feeAtomic.toString(),
      estimatedBtcSat: estimated.toString(),
      levelEstimate: level,
    }
  }

  /** Create, sign and broadcast the freeze transaction. */
  async convert(amountAtomic: bigint, btcAddress: string): Promise<{ txid: string }> {
    const spk = decodeBtcAddress(btcAddress, this.params.btcNetwork).scriptPubKey
    const utxos = await this.wallet.spendable()
    const draft = await this.buildFreezeDraft(utxos, amountAtomic)
    const input0 = draft.unsigned.inputs[0]
    if (input0 === undefined) throw new Error('Coin selection produced no inputs.')
    if (input0.algo !== 'ecdsa' && input0.algo !== 'falcon512') {
      throw new Error(`Unsupported input algorithm: ${input0.algo}`)
    }
    // The reclaim key is the first input's key (the node's convention): a
    // restored wallet rediscovers its freezes by matching hash256 of its own
    // pubkeys against the data prefix.
    const reclaimPubkey = await this.wallet.inputPubkey(input0 as Parameters<DowngradeWallet['inputPubkey']>[0])
    const freezeOut = buildFreezeOutput(
      amountAtomic,
      this.freezeScripthashBytes(),
      reclaimPubkey,
      spk,
    )
    const outputs = draft.unsigned.outputs.map((o, i) => (i === 0 ? { ...o, data: toHex(freezeOut.data!) } : o))
    const signed = await this.wallet.signUnsigned({ ...draft.unsigned, outputs })
    const { txid } = await this.reader.broadcastTransaction(signed.rawHex)
    const episodes = await this.store.load()
    await this.store.save([
      ...episodes,
      {
        freezeTxid: signed.txid,
        vout: 0,
        valueAtomic: amountAtomic.toString(),
        btcScriptPubKeyHex: toHex(spk),
        reclaim: {
          account: input0.account,
          chain: input0.chain,
          index: input0.index,
          algo: input0.algo,
          ...(input0.scheme !== undefined ? { scheme: input0.scheme } : {}),
        },
      },
    ])
    return { txid: txid !== '' ? txid : signed.txid }
  }

  /** Every recorded episode with its live chain state, newest first. */
  async status(): Promise<DowngradeEpisodeView[]> {
    const episodes = await this.store.load()
    const now = Math.floor(Date.now() / 1000)
    const views = await Promise.all(episodes.map((e) => this.episodeView(e, now)))
    return views.reverse()
  }

  /** Reclaim a matured freeze/downgrade output back to the wallet. */
  async reclaim(freezeTxid: string): Promise<{ txid: string }> {
    const episodes = await this.store.load()
    const episode = episodes.find((e) => e.freezeTxid === freezeTxid)
    if (episode === undefined) throw new Error('Unknown conversion.')
    const now = Math.floor(Date.now() / 1000)
    const view = await this.episodeView(episode, now)
    if (view.state !== 'reclaimable' || view.reclaimOutpoint === undefined) {
      throw new Error(
        view.reclaimableAt !== undefined
          ? 'This conversion cannot be reclaimed yet.'
          : 'This conversion has nothing to reclaim.',
      )
    }
    const outpoint = view.reclaimOutpoint
    const value = BigInt(outpoint.valueAtomic)
    const rate = await this.wallet.feeRate()
    // The reclaim input reveals the covenant script and a pubkey — close to a
    // classical input; sized as one input plus two outputs' allowance so the
    // ~60-byte script is comfortably covered at the flat rate.
    const synthetic: SpendableUtxo = { txid: outpoint.txid, vout: outpoint.vout, value, chain: 0, index: 0, algo: episode.reclaim.algo }
    const fee = feeForInputs([synthetic], rate, 2)
    if (value <= fee) throw new Error('The output is too small to pay the reclaim fee.')
    const destAddress = await this.wallet.changeAddressFor(episode.reclaim.algo)
    const redeem =
      outpoint.kind === 'freeze'
        ? freezeScript(this.params.lockPubkey, this.params.freezeSeconds)
        : downgradeScript(this.params.outputSeconds)
    const tx: Transaction = {
      txType: TX_TYPE_STANDARD,
      inputs: [{ txid: fromHex(outpoint.txid), vout: outpoint.vout }],
      outputs: [{ value: value - fee, scripthash: this.wallet.scripthashOf(destAddress) }],
    }
    const keys = await this.wallet.inputKeypair(episode.reclaim)
    try {
      const signed = await signReclaimInput(
        tx,
        { inputIndex: 0, privateKey: keys.privateKey, publicKey: keys.publicKey, algo: episode.reclaim.algo },
        redeem,
      )
      const rawHex = toHex(serialize(signed))
      const result = await this.reader.broadcastTransaction(rawHex)
      return { txid: result.txid !== '' ? result.txid : toHex(computeTxid(signed)) }
    } finally {
      keys.privateKey.fill(0)
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private freezeScripthashBytes(): Uint8Array {
    return reclaimScripthash(freezeScript(this.params.lockPubkey, this.params.freezeSeconds))
  }

  private async buildFreezeDraft(utxos: readonly SpendableUtxo[], amountAtomic: bigint): Promise<BuiltSend> {
    const rate = await this.wallet.feeRate()
    // The freeze output carries ~57 bytes of data on top of a plain output.
    // The flat per-output size model doesn't know that, so the estimated fee
    // gets two extra outputs' worth (68 vbytes) on top — a safe overshoot of
    // a few atomic units at the flat rate.
    const dataAllowance = feeForInputs([], rate, 2) - feeForInputs([], rate, 0)
    const feeAtomic = estimateSendFee({ utxos, amountAtomic, feeRatePerVByte: rate }) + dataAllowance
    const [classicalChange, pqChange] = await Promise.all([
      this.wallet.changeAddressFor('ecdsa'),
      this.wallet.changeAddressFor('falcon512'),
    ])
    return buildSend({
      utxos,
      recipient: this.wallet.freezeAddress(),
      amountAtomic,
      feeAtomic,
      changeAddressFor: (algo) => (algo === 'falcon512' ? pqChange : classicalChange),
    })
  }

  private async episodeView(e: DowngradeEpisodeRecord, now: number): Promise<DowngradeEpisodeView> {
    const base = {
      freezeTxid: e.freezeTxid,
      vout: e.vout,
      valueAtomic: e.valueAtomic,
      ...this.btcAddressOf(e.btcScriptPubKeyHex),
    }
    const freezeTx = await this.reader.getTransaction(e.freezeTxid)
    const freezeSpend = await this.reader.getOutspend(e.freezeTxid, e.vout)
    if (!freezeSpend.spent) {
      const blockTime = freezeTx.status.blockTime
      const matureAt = blockTime !== undefined ? blockTime + this.params.freezeSeconds : undefined
      if (matureAt !== undefined && now >= matureAt) {
        return {
          ...base,
          state: 'reclaimable',
          reclaimOutpoint: { txid: e.freezeTxid, vout: e.vout, valueAtomic: e.valueAtomic, kind: 'freeze' },
        }
      }
      return { ...base, state: 'frozen', ...(matureAt !== undefined ? { reclaimableAt: matureAt } : {}) }
    }
    const spender = await this.reader.getTransaction(freezeSpend.txid!)
    if (spender.version !== 7) {
      // Spent, but not by a downgrade: the only key that can do that through
      // the ELSE branch is ours — a completed reclaim.
      return { ...base, state: 'reclaimed' }
    }
    // The service's downgrade tx: find its covenant output and the payout it
    // committed to.
    const downgradeSh = toHex(reclaimScripthash(downgradeScript(this.params.outputSeconds)))
    const dVout = spender.vout.findIndex((o) => o.scripthash === downgradeSh)
    const btcTxid = spender.downgradeInfo?.btcTxid
    const withDowngrade = {
      ...base,
      downgradeTxid: freezeSpend.txid!,
      ...(btcTxid !== undefined ? { btcTxid } : {}),
    }
    if (dVout === -1) return { ...withDowngrade, state: 'converting' }
    const dSpend = await this.reader.getOutspend(freezeSpend.txid!, dVout)
    if (dSpend.spent) {
      const burn = await this.reader.getTransaction(dSpend.txid!)
      if (burn.version === 6) {
        return { ...withDowngrade, state: 'paid', burnTxid: dSpend.txid! }
      }
      return { ...withDowngrade, state: 'reclaimed' }
    }
    const dValue = spender.vout[dVout]!.value
    const blockTime = spender.status.blockTime
    const matureAt = blockTime !== undefined ? blockTime + this.params.outputSeconds : undefined
    if (matureAt !== undefined && now >= matureAt) {
      return {
        ...withDowngrade,
        state: 'reclaimable',
        reclaimOutpoint: { txid: freezeSpend.txid!, vout: dVout, valueAtomic: dValue.toString(), kind: 'downgrade' },
      }
    }
    return { ...withDowngrade, state: 'converting', ...(matureAt !== undefined ? { reclaimableAt: matureAt } : {}) }
  }

  private btcAddressOf(spkHex: string): { btcAddress?: string } {
    try {
      const addr = btcAddressFromScriptPubKey(fromHex(spkHex), this.params.btcNetwork)
      return addr !== undefined ? { btcAddress: addr } : {}
    } catch {
      return {}
    }
  }
}
