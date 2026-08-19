import type { ReactNode } from 'react'
import { AlertIcon } from './icons'

// The one warning box. Every icon+text notice in the app renders through
// this component, so the triangle is always 16px (wrapped flex-none — a long
// text must never squeeze it), the gaps and radii stay consistent, and a new
// notice can't invent a fifth look.
//
// Variants, from loudest to quietest:
//   banner  — page-level notice: card surface with a warning border
//             (the Convert sync-lag banner).
//   warning — urgent inline box: warning-tinted surface and text
//             (fee shortfalls on Send).
//   caution — inline caution on a neutral well: the text is ordinary ink,
//             only the icon carries the warning colour (one-way notes,
//             dialog fine print).
//   chip    — compact single-line hint (the "not in your contacts" nudge).
export type AlertVariant = 'banner' | 'warning' | 'caution' | 'chip'

const BOX: Record<AlertVariant, React.CSSProperties> = {
  banner: { gap: 10, padding: '12px 14px', borderRadius: 12, background: 'var(--card)', border: '1px solid var(--warning)' },
  warning: { gap: 9, padding: '11px 13px', borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 32%, transparent)' },
  caution: { gap: 9, padding: '10px 12px', borderRadius: 10, background: 'var(--well)', border: '1px solid var(--border)' },
  chip: { gap: 6, padding: '7px 10px', borderRadius: 8, background: 'color-mix(in srgb, var(--warning) 13%, transparent)' },
}

const TEXT: Record<AlertVariant, React.CSSProperties> = {
  banner: { fontSize: 12.5, color: 'var(--ink-700)', lineHeight: 1.5 },
  warning: { fontSize: 12.5, color: 'var(--ink-700)', lineHeight: 1.5 },
  caution: { fontSize: 12, color: 'var(--ink-700)', lineHeight: 1.5 },
  chip: { fontSize: 12, color: 'var(--warning)', fontWeight: 500 },
}

export function Alert({ variant = 'caution', children, style }: { variant?: AlertVariant; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      role="status"
      style={{ display: 'flex', alignItems: variant === 'chip' ? 'center' : 'flex-start', ...BOX[variant], ...style }}
    >
      <span style={{ flex: 'none', color: 'var(--warning)', display: 'flex', marginTop: variant === 'chip' ? 0 : 1 }}>
        <AlertIcon size={16} />
      </span>
      <span style={{ minWidth: 0, ...TEXT[variant] }}>{children}</span>
    </div>
  )
}
