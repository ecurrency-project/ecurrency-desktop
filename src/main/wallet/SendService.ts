import type { MaxSendable, SendPreview, SendResult, TokenSendPreview } from '../../shared/protocol'
import { buildSend, buildTokenSend, estimateSendFee, feeForInputs, InsufficientFundsError, InsufficientTokensError, selectByToken, selectCoins, type ChangeBranch, type SpendableTokenUtxo, type SpendableUtxo, type UnsignedTx } from './buildTx'
import type { GatheredUtxo } from './spendable'
import type { SignedTx } from './signTx'

// Dependencies, injected so the service is testable without crypto or network.
export interface SendDeps {
  gather(): Promise<GatheredUtxo[]>
  /** Fee rate in atomic units per vByte. */
  feeRate(): Promise<number>
  /** Outpoints (`txid:vout`) the user froze — excluded from automatic selection. */
  frozen(): Promise<ReadonlySet<string>>
  /** A fresh classical (ECDSA) change address. */
  getChangeAddress(): Promise<string>
  /** A fresh post-quantum (Falcon) change address. */
  getPqChangeAddress(): Promise<string>
  /** Advance the change index on the HD branch the change output used. A key
   *  wallet has no branches to advance — its implementation is a no-op. */
  advanceChange(algo: ChangeBranch): Promise<void>
  sign(unsigned: UnsignedTx): Promise<SignedTx>
  broadcast(rawHex: string): Promise<string>
  /** Called after a successful broadcast so a cached spend pool can be dropped. */
  onSpent?(): void
}

const outpointOf = (u: SpendableUtxo): string => `${u.txid}:${String(u.vout)}`

// Orchestrates a send in two steps. buildSend assembles and HOLDS an unsigned
// draft and returns a preview to review; confirmSend signs that held draft,
// broadcasts it, and advances the change index. With an explicit `outpoints`
// set the user spends exactly those coins (manual coin control); otherwise the
// service auto-selects from the unfrozen pool. The held draft carries no secrets;
// signing happens only on confirm, in main, with keys derived from the Vault.
export class SendService {
  // The held draft: the unsigned tx plus which change branches to advance on confirm
  // (one for a native send; up to two — token + native — for a token send).
  private pending: { unsigned: UnsignedTx; advance: readonly ChangeBranch[]; recipient: string } | null = null

  constructor(private readonly deps: SendDeps) {}

  async buildSend(recipient: string, amountAtomic: bigint, outpoints?: readonly string[], sendMax = false): Promise<SendPreview> {
    const { utxos, manualInputs } = await this.resolveInputs(outpoints)
    const rate = await this.deps.feeRate()
    // One estimator for every path (auto / manual / send-max), sized to the
    // actual inputs and change shape, so the preview fee equals the built fee
    // and auto and manual agree on the same coin set. Throws InsufficientFunds
    // here (before building) when even a changeless send can't be funded.
    const feeAtomic = estimateSendFee({ utxos, manualInputs, amountAtomic, feeRatePerVByte: rate, sendMax })

    // Pre-derive both change addresses; buildSend picks one by the inputs' majority
    // algorithm so a PQ-funded send keeps its change post-quantum.
    const [classicalChange, pqChange] = await Promise.all([this.deps.getChangeAddress(), this.deps.getPqChangeAddress()])
    const built = buildSend({
      utxos,
      manualInputs,
      recipient,
      amountAtomic,
      feeAtomic,
      sendMax,
      changeAddressFor: (algo) => (algo === 'falcon512' ? pqChange : classicalChange),
    })
    this.pending = {
      unsigned: built.unsigned,
      advance: built.changeAtomic > 0n && built.changeAlgo !== undefined ? [built.changeAlgo] : [],
      recipient,
    }
    // Report which signature scheme(s) the chosen inputs use, for the review.
    const algos = new Set(built.unsigned.inputs.map((i) => i.algo))
    const signature = [...algos].map((a) => (a === 'falcon512' ? 'Falcon-512' : a === 'schnorr' ? 'Schnorr' : 'ECDSA')).join(' + ')
    return {
      recipient,
      amountAtomic: built.amountAtomic.toString(),
      feeAtomic: built.feeAtomic.toString(),
      changeAtomic: built.changeAtomic.toString(),
      totalAtomic: built.totalAtomic.toString(),
      signature,
    }
  }

  // Resolve the spend pool: a manual set (validated, frozen rejected) when
  // `outpoints` is given, otherwise every unfrozen coin. Shared by buildSend and
  // maxSendable so both honour the same freeze rules and availability checks.
  private async resolveInputs(outpoints?: readonly string[]): Promise<{ utxos: readonly GatheredUtxo[]; manualInputs?: readonly GatheredUtxo[] }> {
    // Native sends spend native UTXOs only — token UTXOs (value 0) are filtered out;
    // the token-send path selects those by token id instead.
    const all = (await this.deps.gather()).filter((u) => u.tokenId === undefined)
    const frozen = await this.deps.frozen()
    if (outpoints !== undefined && outpoints.length > 0) {
      const wanted = new Set(outpoints)
      if ([...wanted].some((o) => frozen.has(o))) {
        throw new Error('Frozen coins can’t be spent. Unfreeze them first.')
      }
      const manual = all.filter((u) => wanted.has(outpointOf(u)))
      if (manual.length !== wanted.size) {
        throw new Error('Some selected coins are no longer available.')
      }
      return { utxos: [], manualInputs: manual }
    }
    return { utxos: all.filter((u) => !frozen.has(outpointOf(u))) }
  }

  // The largest amount sendable in one transaction: the whole spendable pool (or
  // the manually chosen coins) minus the fee for spending all of them, with no
  // change. Recipient-free and holds no draft — it just sizes the Max button.
  async maxSendable(outpoints?: readonly string[]): Promise<MaxSendable> {
    const { utxos, manualInputs } = await this.resolveInputs(outpoints)
    const inputs = manualInputs ?? utxos
    const rate = await this.deps.feeRate()
    // Send-max produces a single output (no change), so price it that way — the
    // same shape confirmSend will build.
    const feeAtomic = estimateSendFee({ utxos, manualInputs, amountAtomic: 0n, feeRatePerVByte: rate, sendMax: true })
    const sum = inputs.reduce((total, u) => total + u.value, 0n)
    const amountAtomic = sum - feeAtomic
    if (amountAtomic <= 0n) {
      throw new InsufficientFundsError(feeAtomic, sum)
    }
    return { amountAtomic: amountAtomic.toString(), feeAtomic: feeAtomic.toString() }
  }

  // Build and hold a token transfer. Token UTXOs of the chosen token cover the
  // amount (with token change to self); unfrozen native coin pays the fee (token
  // UTXOs are value 0). The fee covers the whole tx, so it's computed in two passes:
  // estimate from the token inputs, pick native coins to cover that, then recompute from the
  // real input set. Holds the draft for confirmSend; advances both change branches.
  async buildTokenSend(tokenId: string, recipient: string, tokenAmount: bigint): Promise<TokenSendPreview> {
    const all = await this.deps.gather()
    const frozen = await this.deps.frozen()
    const tokenUtxos: SpendableTokenUtxo[] = all
      .filter((u) => u.tokenId === tokenId && u.tokenAmount !== undefined)
      .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, chain: u.chain, index: u.index, algo: u.algo, scheme: u.scheme, tokenAmount: u.tokenAmount as bigint }))
    const nativeUtxos = all.filter((u) => u.tokenId === undefined && !frozen.has(outpointOf(u)))

    const rate = await this.deps.feeRate()
    const tokenSel = selectByToken(tokenUtxos, tokenAmount)
    if (tokenSel === null) {
      throw new InsufficientTokensError(tokenAmount, tokenUtxos.reduce((s, u) => s + u.tokenAmount, 0n))
    }
    let feeAtomic = feeForInputs(tokenSel, rate, 3)
    for (let pass = 0; pass < 2; pass++) {
      const nativeSel = selectCoins(nativeUtxos, feeAtomic)
      if (nativeSel === null) break // buildTokenSend throws the precise "need native coins for fee" error
      feeAtomic = feeForInputs([...tokenSel, ...nativeSel], rate, 3)
    }

    const [classicalChange, pqChange] = await Promise.all([this.deps.getChangeAddress(), this.deps.getPqChangeAddress()])
    const changeFor = (algo: ChangeBranch): string => (algo === 'falcon512' ? pqChange : classicalChange)
    const built = buildTokenSend({
      tokenHash: tokenId,
      tokenUtxos,
      nativeUtxos,
      recipient,
      tokenAmount,
      feeAtomic,
      tokenChangeAddressFor: changeFor,
      nativeChangeAddressFor: changeFor,
    })
    this.pending = {
      unsigned: built.unsigned,
      advance: [...new Set([built.tokenChangeAlgo, built.nativeChangeAlgo].filter((a): a is ChangeBranch => a !== undefined))],
      recipient,
    }
    const algos = new Set(built.unsigned.inputs.map((i) => i.algo))
    const signature = [...algos].map((a) => (a === 'falcon512' ? 'Falcon-512' : a === 'schnorr' ? 'Schnorr' : 'ECDSA')).join(' + ')
    return {
      recipient,
      tokenId,
      tokenAmountAtomic: built.tokenAmountAtomic.toString(),
      feeAtomic: built.feeAtomic.toString(),
      signature,
    }
  }

  async confirmSend(): Promise<SendResult> {
    const pending = this.pending
    if (pending === null) {
      throw new Error('No transaction to confirm. Build a send first.')
    }
    const signed = await this.deps.sign(pending.unsigned)
    await this.deps.broadcast(signed.rawHex)
    this.deps.onSpent?.()
    for (const algo of pending.advance) {
      await this.deps.advanceChange(algo)
    }
    this.pending = null
    return { txid: signed.txid }
  }

  /** Drop any held draft (e.g. on lock/destroy). */
  reset(): void {
    this.pending = null
  }
}
