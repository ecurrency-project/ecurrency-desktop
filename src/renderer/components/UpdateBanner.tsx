import { type CSSProperties } from 'react'
import { dismissUpdate, restartToInstall, useUpdateStatus } from '../lib/updates'
import { Button } from '../ui'

// Slim bar under the title bar, shown while an update is downloading or once it's
// ready. Replaces the OS dialog: the user restarts in-app or dismisses (the update
// still installs on next quit). 'available' and 'error' stay silent — they're
// handled in main (auto-download / logged).
export function UpdateBanner() {
  const status = useUpdateStatus()
  if (status === null) return null

  if (status.kind === 'downloaded') {
    return (
      <div style={bar}>
        <span style={{ fontSize: 13, color: 'var(--ink-900)' }}>Update {status.version} is ready to install.</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" onClick={() => restartToInstall()}>
            Restart now
          </Button>
          <Button size="sm" variant="secondary" onClick={() => dismissUpdate()}>
            Later
          </Button>
        </span>
      </div>
    )
  }

  if (status.kind === 'progress') {
    return (
      <div style={bar}>
        <span style={{ fontSize: 13, color: 'var(--ink-700)' }}>Downloading update… {status.percent}%</span>
      </div>
    )
  }

  return null
}

const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '8px 14px',
  background: 'var(--card-el)',
  borderBottom: '1px solid var(--border)',
}
