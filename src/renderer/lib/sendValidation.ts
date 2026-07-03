// Pure validation helpers for the Send form — extracted so the (otherwise
// component-bound) logic can be unit-tested. Two bugs lived here:
//   1. detecting an insufficient-funds build failure by the error NAME, which
//      doesn't survive the IPC bridge — detect by the stable message instead;
//   2. an off-by-one in the manual coin-selection check (`<` where the ever-
//      present positive fee makes `<=` correct).

/**
 * True if a failed native-send draft build means "the inputs can't cover the
 * amount plus the fee". Matched on the message text, NOT the Error name: only
 * `{ name, message }` crosses the wallet IPC bridge and the custom name is not
 * reconstructed reliably, whereas InsufficientFundsError's message is stable
 * (see buildTx in main). Kept as a predicate so a change to that
 * message trips the unit test binding the two together.
 */
export function isInsufficientFundsError(message: string): boolean {
  return /not enough balance/i.test(message)
}

export interface CoinSelectionState {
  /** How many UTXOs the user manually selected (0 = automatic selection). */
  readonly selectedCount: number
  /** Send-max spends everything, so a manual shortfall check doesn't apply. */
  readonly maxMode: boolean
  /** Sum of the selected UTXOs, atomic. */
  readonly picked: bigint
  /** Parsed send amount, atomic; null when the amount field isn't a valid number. */
  readonly amount: bigint | null
  /** Live fee from the draft build, atomic; null when unknown (not yet built, or
   *  the build refused because the selection can't be funded). */
  readonly fee: bigint | null
  /** The draft build refused with an insufficient-funds error. */
  readonly feeShort: boolean
}

/**
 * Whether the manually selected coins fall short of the send. Only meaningful
 * for a manual selection (automatic selection lets main choose from the whole
 * pool). The fee is always > 0, so:
 *   - fee known  → short iff picked < amount + fee
 *   - fee unknown → any selection AT OR BELOW the bare amount is short for
 *     certain (`<=`); the fee-sized gap just above the amount is covered by
 *     `feeShort` (the build itself refused, so the exact fee can't be computed).
 */
export function coinSelectionShort(s: CoinSelectionState): boolean {
  if (s.selectedCount === 0 || s.maxMode) return false
  if (s.feeShort) return true
  if (s.amount === null) return false
  if (s.fee !== null) return s.picked < s.amount + s.fee
  return s.picked <= s.amount
}
