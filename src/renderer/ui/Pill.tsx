import type { ReactNode } from 'react'

export type PillTone = 'pq' | 'frozen' | 'watch' | 'warning' | 'success' | 'neutral'

// Small status chip. `tone` selects the token pair (see .pill in app.css).
export function Pill({ tone = 'neutral', icon, children }: { tone?: PillTone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="pill" data-tone={tone}>
      {icon}
      {children}
    </span>
  )
}
