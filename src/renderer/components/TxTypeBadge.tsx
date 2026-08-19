import { Pill, type PillTone } from '../ui'

// Badge copy for the non-standard transaction types (protocol tx_type ids).
// Standard (1) never shows a badge and tokens (4) already read as their
// ticker headline; 0 is a type this build does not know yet.
const BADGES: Record<number, { label: string; tone: PillTone }> = {
  0: { label: 'Unknown type', tone: 'neutral' },
  2: { label: 'Stake', tone: 'neutral' },
  3: { label: 'Coinbase', tone: 'neutral' },
  5: { label: 'Slashing', tone: 'warning' },
  6: { label: 'Burn', tone: 'warning' },
  7: { label: 'Downgrade', tone: 'neutral' },
  8: { label: 'Upgrade stop', tone: 'neutral' },
}

/** Small chip naming a non-standard transaction type; renders nothing for
 *  ordinary transfers. Shared by the history rows and the detail drawer. */
export function TxTypeBadge({ txType }: { txType?: number }) {
  const badge = txType !== undefined ? BADGES[txType] : undefined
  if (badge === undefined) return null
  return <Pill tone={badge.tone}>{badge.label}</Pill>
}
