// Display helpers for the renderer. Amounts arrive as atomic native-coin strings over the
// IPC bridge (bigint-safe); we format with integer math only — never floats.
// Brand-free on purpose: the native ticker is per-network, so callers pass it in.

// The native coin has 10^8 atomic units (mirrors the node's denominator).
const NATIVE_DECIMALS = 8

/** Format an atomic amount as a decimal string for a given decimal precision,
 *  trimming trailing zeros. Integer math only (no floats). Tokens carry their own
 *  `decimals` (default 6); native coin is 8. */
export function formatToken(atomic: string, decimals: number): string {
  let s = atomic.trim()
  const negative = s.startsWith('-')
  if (negative) s = s.slice(1)
  if (!/^\d+$/.test(s)) return '0'
  if (decimals <= 0) return negative ? `-${s}` : s

  const base = 10n ** BigInt(decimals)
  const value = BigInt(s)
  const whole = (value / base).toString()
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  const out = frac.length > 0 ? `${whole}.${frac}` : whole
  return negative ? `-${out}` : out
}

/** Parse a decimal string into atomic units (bigint) at a given precision. Throws
 *  on bad input or on more fraction digits than `decimals` allows. */
export function parseToken(decimal: string, decimals: number): bigint {
  const s = decimal.trim()
  const re = decimals <= 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${String(decimals)}})?$`)
  if (!re.test(s)) {
    throw new Error(`Enter a valid amount with up to ${String(decimals)} decimal places.`)
  }
  const [whole, frac = ''] = s.split('.')
  return BigInt(whole) * 10n ** BigInt(decimals) + (decimals <= 0 ? 0n : BigInt(frac.padEnd(decimals, '0')))
}

/** Format an atomic native-coin string as a decimal string, trimming trailing zeros. */
export function formatNative(atomic: string): string {
  return formatToken(atomic, NATIVE_DECIMALS)
}

/** The fee field is a signed delta for stake transactions. Its reward belongs
 *  to the whole transaction, separately from this wallet's received amount. */
export function transactionFeeDisplay(tx: { txType?: number; feeAtomic: string }): { label: string; amountAtomic: string } {
  if (tx.txType === 2 && BigInt(tx.feeAtomic) < 0n) {
    return { label: 'Staking reward', amountAtomic: (-BigInt(tx.feeAtomic)).toString() }
  }
  return {
    label: tx.txType === 5 ? 'Penalty' : tx.txType === 6 ? 'Burned' : 'Fee',
    amountAtomic: tx.feeAtomic,
  }
}

/** Parse a decimal native-coin string into atomic units (bigint). Throws on bad input. */
export function parseNative(decimal: string): bigint {
  return parseToken(decimal, NATIVE_DECIMALS)
}

/** Abbreviate a txid/hash for compact display. */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash
}

/** The headline amount for a history row: the token movement when the transaction
 *  moved a token, otherwise native coin. The caller prefixes the +/− sign and
 *  passes the native ticker (per-network — see `useAssetLabel`). */
export function historyAmount(tx: { tokenId?: string; tokenAmountAtomic?: string; tokenDecimals?: number; tokenTicker?: string; amountAtomic: string }, assetLabel: string): string {
  if (tx.tokenId !== undefined) return `${formatToken(tx.tokenAmountAtomic ?? '0', tx.tokenDecimals ?? 6)} ${tx.tokenTicker ?? 'Token'}`
  return `${formatNative(tx.amountAtomic)} ${assetLabel}`
}

/** A token's compact ticker (e.g. "USDT") and full name (e.g. "Tether USD"). The
 *  node's metadata isn't consistent about which of symbol/name holds which, so we
 *  pick by length: the shorter label is the ticker, the longer is the name. */
export function tokenLabels(t: { symbol?: string; name?: string }): { ticker: string; name: string } {
  const both = [t.symbol, t.name].map((x) => x?.trim()).filter((x): x is string => x !== undefined && x.length > 0)
  if (both.length === 0) return { ticker: 'Token', name: 'Token' }
  if (both.length === 1) return { ticker: both[0], name: both[0] }
  const [a, b] = both
  return a.length <= b.length ? { ticker: a, name: b } : { ticker: b, name: a }
}
