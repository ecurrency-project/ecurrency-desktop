import {
  decodeBtcAddress,
  fromHex,
  scriptBtcOpReturn,
  serializeBtcTx,
  signBtcP2pkhSpend,
  toHex,
  type BtcNetwork,
  type BtcOutPoint,
  type BtcTxOutput,
  type HDKey,
} from '@qbitcoin/crypto'
import type { BtcHistoryTx, BtcUtxo } from '@qbitcoin/chain'
import { deriveBtcStagingAddress, deriveBtcStagingKey } from './btcStaging'

// The BTC→native upgrade flow, main-process core (design:
// docs/btc-upgrade-design.md §4.1). One staging episode = one fresh
// P2PKH key; this service derives it, watches it through a Bitcoin
// esplora, builds/signs/broadcasts the conversion spend (lock output +
// OP_RETURN destination commitment), and reconstructs episode status
// from chain data alone — local state is only a cache (restore
// scenario R1).
//
// Brand-agnostic: the lock script and limits arrive as parameters. On
// the base branch nothing instantiates this service (`upgrade` brand
// config is null); brand branches wire it up.

/** Brand-supplied parameters of the upgrade protocol. */
export interface UpgradeParams {
  /** Exact scriptPubKey (hex) of the chain's BTC lock/freeze output. */
  readonly lockScriptHex: string
  /** Smallest convertible amount, in satoshi. */
  readonly minConvertValue: bigint
  /** Below this, change is folded into the fee instead of created. */
  readonly dustLimit: bigint
  /** Fee-estimate confirmation target, in blocks. */
  readonly feeTargetBlocks: number
  /** sat/vB used when the fee oracle has no usable answer. */
  readonly fallbackFeeRate: number
}

/** The subset of BtcEsploraClient the service consumes (structural). */
export interface BtcChainReader {
  addressUtxos(address: string): Promise<BtcUtxo[]>
  addressTxs(address: string): Promise<BtcHistoryTx[]>
  feeEstimates(): Promise<ReadonlyMap<number, number>>
  broadcast(rawTxHex: string): Promise<string>
  tipHeight(): Promise<number>
}

/** Persisted staging cursor (sealed blob at the wiring layer). */
export interface UpgradeStore {
  loadStagingIndex(): Promise<number>
  saveStagingIndex(index: number): Promise<void>
}

export interface UpgradeVault {
  getMasterKey(): Promise<HDKey>
  on(listener: (event: { readonly type: string }) => void): () => void
}

/** A conversion episode reconstructed from the chain. */
export interface UpgradeEpisode {
  readonly txid: string
  /** Satoshi locked (the value of the lock output). */
  readonly lockValue: bigint
  /** Destination scripthash committed via OP_RETURN, hex; null = fallback credit. */
  readonly destScripthashHex: string | null
  readonly confirmed: boolean
  readonly blockHeight?: number
  /** BTC confirmations at status time (credits need 6 + a 2h timer). */
  readonly confirmations?: number
}

export interface UpgradeStatus {
  readonly stagingAddress: string
  readonly stagingIndex: number
  /** Sum of confirmed UTXOs, satoshi. */
  readonly confirmedBalance: bigint
  /** Sum of unconfirmed (mempool) UTXOs, satoshi. */
  readonly pendingBalance: bigint
  readonly episodes: readonly UpgradeEpisode[]
}

export type ConvertRequest = { readonly mode: 'all' } | { readonly mode: 'amount'; readonly amountSat: bigint }

export interface ConvertPlan {
  /** Satoshi that end up in the lock output (what the credit is computed from). */
  readonly sendValue: bigint
  readonly fee: bigint
  /** Change returned to the NEXT staging index; 0n when none. */
  readonly changeValue: bigint
  readonly feeRate: number
  /** True when a sub-dust remainder was folded into the fee. */
  readonly foldedChange: boolean
  readonly inputs: readonly BtcOutPoint[]
}

export class UpgradeService {
  private stagingIndex: number | null = null

  constructor(
    private readonly vault: UpgradeVault,
    private readonly store: UpgradeStore,
    private readonly chain: BtcChainReader,
    private readonly params: UpgradeParams,
    private readonly network: BtcNetwork = 'mainnet',
  ) {
    this.vault.on((event) => {
      if (event.type === 'locked' || event.type === 'destroyed' || event.type === 'created') {
        this.stagingIndex = null
      }
    })
  }

  /** The current deposit address (fresh per episode). */
  async stagingAddress(): Promise<{ address: string; index: number }> {
    const index = await this.ensureIndex()
    const master = await this.vault.getMasterKey()
    return { address: deriveBtcStagingAddress(master, index, this.network), index }
  }

  /** Balance of the current staging address + episodes recovered from chain. */
  async status(): Promise<UpgradeStatus> {
    const { address, index } = await this.stagingAddress()
    const utxos = await this.chain.addressUtxos(address)
    let confirmed = 0n
    let pending = 0n
    for (const u of utxos) {
      if (u.confirmed) confirmed += u.value
      else pending += u.value
    }
    return {
      stagingAddress: address,
      stagingIndex: index,
      confirmedBalance: confirmed,
      pendingBalance: pending,
      episodes: await this.reconstructEpisodes(index),
    }
  }

  /**
   * Price a conversion without touching keys. Recomputed inside
   * `convert()` — a plan is a preview, never an order.
   */
  async planConvert(request: ConvertRequest): Promise<ConvertPlan> {
    const { address } = await this.stagingAddress()
    const utxos = (await this.chain.addressUtxos(address)).filter((u) => u.confirmed)
    if (utxos.length === 0) throw new Error('Nothing to convert: no confirmed BTC on the staging address.')
    const total = utxos.reduce((s, u) => s + u.value, 0n)
    const feeRate = await this.feeRate()
    const inputs = utxos.map((u) => ({ txid: u.txid, vout: u.vout }))

    if (request.mode === 'all') {
      const fee = feeFor(sizeFor(utxos.length, [LOCK_OUT_LEN, OP_RETURN_OUT_LEN]), feeRate)
      const sendValue = total - fee
      this.assertConvertible(sendValue)
      return { sendValue, fee, changeValue: 0n, feeRate, foldedChange: false, inputs }
    }

    const amount = request.amountSat
    this.assertConvertible(amount)
    const feeWithChange = feeFor(sizeFor(utxos.length, [LOCK_OUT_LEN, OP_RETURN_OUT_LEN, LOCK_OUT_LEN]), feeRate)
    const remainder = total - amount - feeWithChange
    if (remainder < 0n) {
      throw new Error('Insufficient confirmed balance for this amount plus the network fee.')
    }
    if (remainder <= this.params.dustLimit) {
      // Sub-dust remainder: no change output; the remainder joins the fee.
      const feeNoChange = total - amount
      return { sendValue: amount, fee: feeNoChange, changeValue: 0n, feeRate, foldedChange: remainder > 0n, inputs }
    }
    return { sendValue: amount, fee: feeWithChange, changeValue: remainder, feeRate, foldedChange: false, inputs }
  }

  /**
   * Build, sign and broadcast the conversion spend. `destScripthash` is
   * the native-chain scripthash (20 or 32 bytes) the credit should go to —
   * the caller decodes the user's address. Returns the episode txid.
   */
  async convert(request: ConvertRequest, destScripthash: Uint8Array): Promise<{ txid: string; plan: ConvertPlan }> {
    if (destScripthash.length !== 20 && destScripthash.length !== 32) {
      throw new Error(`Destination scripthash must be 20 or 32 bytes, got ${destScripthash.length}`)
    }
    const plan = await this.planConvert(request)
    const index = await this.ensureIndex()
    const master = await this.vault.getMasterKey()

    const outputs: BtcTxOutput[] = [
      { value: plan.sendValue, scriptPubKey: fromHex(this.params.lockScriptHex) },
      { value: 0n, scriptPubKey: scriptBtcOpReturn(destScripthash) },
    ]
    if (plan.changeValue > 0n) {
      // Change moves to the NEXT staging index: fresh key, no reuse of a
      // pubkey that this very transaction reveals (design §4.1a).
      const nextAddress = deriveBtcStagingAddress(master, index + 1, this.network)
      outputs.push({ value: plan.changeValue, scriptPubKey: decodeBtcAddress(nextAddress, this.network).scriptPubKey })
    }

    const key = deriveBtcStagingKey(master, index, this.network)
    let rawHex: string
    try {
      const tx = signBtcP2pkhSpend({ prevouts: plan.inputs, outputs }, key.privateKey)
      rawHex = toHex(serializeBtcTx(tx))
    } finally {
      key.wipe()
    }

    const txid = await this.chain.broadcast(rawHex)
    if (plan.changeValue > 0n) {
      await this.store.saveStagingIndex(index + 1)
      this.stagingIndex = index + 1
    }
    return { txid, plan }
  }

  /** R5: send the entire staging balance back to an arbitrary BTC address. */
  async returnAll(destAddress: string): Promise<{ txid: string; value: bigint; fee: bigint }> {
    const { address, index } = await this.stagingAddress()
    const utxos = (await this.chain.addressUtxos(address)).filter((u) => u.confirmed)
    if (utxos.length === 0) throw new Error('Nothing to return: no confirmed BTC on the staging address.')
    const dest = decodeBtcAddress(destAddress, this.network)
    const total = utxos.reduce((s, u) => s + u.value, 0n)
    const feeRate = await this.feeRate()
    const fee = feeFor(sizeFor(utxos.length, [9 + dest.scriptPubKey.length]), feeRate)
    const value = total - fee
    if (value <= this.params.dustLimit) throw new Error('Balance is too small to return after the network fee.')

    const master = await this.vault.getMasterKey()
    const key = deriveBtcStagingKey(master, index, this.network)
    let rawHex: string
    try {
      const tx = signBtcP2pkhSpend(
        { prevouts: utxos.map((u) => ({ txid: u.txid, vout: u.vout })), outputs: [{ value, scriptPubKey: dest.scriptPubKey }] },
        key.privateKey,
      )
      rawHex = toHex(serializeBtcTx(tx))
    } finally {
      key.wipe()
    }
    return { txid: await this.chain.broadcast(rawHex), value, fee }
  }

  // ── Internals ────────────────────────────────────────────────────────

  /** Episodes = outgoing txs paying the lock script, across used indices. */
  private async reconstructEpisodes(currentIndex: number): Promise<UpgradeEpisode[]> {
    const master = await this.vault.getMasterKey()
    const episodes: UpgradeEpisode[] = []
    const seen = new Set<string>()
    // One tip read per refresh gives every confirmed episode its depth; a
    // failed read just omits the confirmation counters (cosmetic).
    let tip: number | null = null
    try {
      tip = await this.chain.tipHeight()
    } catch {
      tip = null
    }
    for (let i = 0; i <= currentIndex; i += 1) {
      const address = deriveBtcStagingAddress(master, i, this.network)
      for (const tx of await this.chain.addressTxs(address)) {
        if (seen.has(tx.txid)) continue
        const lockAt = tx.outputs.findIndex((o) => o.scriptPubKeyHex === this.params.lockScriptHex)
        if (lockAt === -1) continue
        seen.add(tx.txid)
        const next = tx.outputs[lockAt + 1]
        const destScripthashHex =
          next !== undefined && next.scriptPubKeyHex.startsWith('6a') ? next.scriptPubKeyHex.slice(4) : null
        episodes.push({
          txid: tx.txid,
          lockValue: tx.outputs[lockAt]!.value,
          destScripthashHex,
          confirmed: tx.status.confirmed,
          ...(tx.status.blockHeight !== undefined ? { blockHeight: tx.status.blockHeight } : {}),
          ...(tx.status.blockHeight !== undefined && tip !== null && tip >= tx.status.blockHeight
            ? { confirmations: tip - tx.status.blockHeight + 1 }
            : {}),
        })
      }
    }
    return episodes
  }

  private async feeRate(): Promise<number> {
    try {
      const estimates = await this.chain.feeEstimates()
      const rate = estimates.get(this.params.feeTargetBlocks)
      // Floor at 1 sat/vB: an idle (testnet) oracle can answer ~0.1, which
      // sits below most nodes' minrelay — a tx that low may never propagate.
      if (rate !== undefined && rate > 0) return Math.max(1, rate)
    } catch {
      // fall through to the fallback rate
    }
    return Math.max(1, this.params.fallbackFeeRate)
  }

  private assertConvertible(value: bigint): void {
    if (value < this.params.minConvertValue) {
      throw new Error(`Amount is below the minimum convertible value (${this.params.minConvertValue} sat).`)
    }
  }

  private async ensureIndex(): Promise<number> {
    if (this.stagingIndex === null) this.stagingIndex = await this.store.loadStagingIndex()
    return this.stagingIndex
  }
}

// Output sizes for fee math: 8 (value) + 1 (script varint) + script.
const LOCK_OUT_LEN = 9 + 25 // P2PKH-shaped lock output
const OP_RETURN_OUT_LEN = 9 + 34 // OP_RETURN with a 32-byte payload (worst case)

/** Legacy-P2PKH spend size: overhead + worst-case signed inputs + outputs. */
function sizeFor(inputCount: number, outputLens: readonly number[]): number {
  return 10 + inputCount * 149 + outputLens.reduce((s, l) => s + l, 0)
}

function feeFor(size: number, rate: number): bigint {
  return BigInt(Math.ceil(size * rate))
}
