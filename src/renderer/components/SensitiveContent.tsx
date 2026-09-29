import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SensitiveAccess } from '../lib/useSensitiveSession'
import { Button, Pill } from '../ui'

export const secretInputProps = { autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false } as const
export const preventSecretExport = {
  onCopyCapture: (event: { preventDefault(): void }) => event.preventDefault(),
  onCutCapture: (event: { preventDefault(): void }) => event.preventDefault(),
  onDragStartCapture: (event: { preventDefault(): void }) => event.preventDefault(),
}

// Secrets render only inside an active sensitive session. Until then the user
// sees one line and one action named for what happens next; the click starts the
// session (and, with onStart, continues straight into the task).
export function SensitiveContent({ access, action, layout = 'dialog', onStart, children }: {
  access: SensitiveAccess
  /** Label of the action that starts the session, e.g. "Enter private key". */
  action?: string
  /** 'screen': a full-screen step where this is the main action; 'dialog': inside a modal. */
  layout?: 'screen' | 'dialog'
  onStart?: () => void
  children: ReactNode
}) {
  const screen = layout === 'screen'
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!access.active) return
    // A selection can start outside this subtree (Select All / Edit menu), so
    // also block exports whose selection intersects the sensitive region.
    const prevent = (event: Event): void => {
      const node = root.current
      const selection = window.getSelection()
      if (node && (node.contains(document.activeElement) || selection?.containsNode(node, true))) event.preventDefault()
    }
    document.addEventListener('copy', prevent, true)
    document.addEventListener('cut', prevent, true)
    document.addEventListener('dragstart', prevent, true)
    return () => {
      document.removeEventListener('copy', prevent, true)
      document.removeEventListener('cut', prevent, true)
      document.removeEventListener('dragstart', prevent, true)
    }
  }, [access.active])
  if (access.active) return (
    <div ref={root} data-sensitive-content {...preventSecretExport} style={{ width: '100%', marginTop: screen ? 18 : 0 }}>
      <SessionBar access={access} />
      {children}
    </div>
  )
  if (action === undefined) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', marginTop: screen ? 18 : 0 }}>
      <PrivacyNote access={access} />
      <StartSession access={access} label={action} screen={screen} onStart={onStart} />
    </div>
  )
}

// The single reminder shown before a secret appears, plus any error.
export function PrivacyNote({ access }: { access: SensitiveAccess }) {
  const restricted = access.capture === 'limited' || access.capture === 'unsupported'
  const error = access.error ?? (access.capture === 'error' ? "Couldn't turn on screen protection. Try again." : null)
  return (
    <>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--ink-500)' }}>
        {restricted ? 'Make sure no one else can see your screen, and pause any screen sharing or recording.' : 'Make sure no one else can see your screen.'}
      </p>
      {error !== null && <p role="alert" className="field-hint field-hint--error" style={{ margin: 0 }}>{error}</p>}
    </>
  )
}

function StartSession({ access, label, screen, onStart }: { access: SensitiveAccess; label: string; screen: boolean; onStart?: () => void }) {
  const hintId = useId()
  const failed = access.capture === 'error'
  const start = async (): Promise<void> => {
    if (failed) await access.controller.refresh()
    if (await access.begin()) onStart?.()
  }
  return (
    <>
      <Button fullWidth variant={screen ? 'primary' : 'secondary'} size={screen ? 'cta' : 'md'} data-testid="privacy-continue" aria-describedby={hintId}
        disabled={access.capture === 'loading' || access.preparing} onClick={() => void start()}>
        {access.preparing ? 'Preparing…' : failed ? 'Try again' : label}
      </Button>
      <span id={hintId} className="sr-only">A screen reader will read the secret aloud once it is shown.</span>
    </>
  )
}

function SessionBar({ access }: { access: SensitiveAccess }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--ink-500)' }}>
        Hides in <Pill tone="neutral"><SessionCountdown deadline={access.session!.deadline} /></Pill> or when you leave this window
      </span>
      <Button variant="ghost" size="sm" onClick={() => access.controller.stop()}>Hide now</Button>
    </div>
  )
}

function SessionCountdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000))
  // A timer is discoverable by assistive technology without announcing every tick.
  return <span role="timer" aria-live="off">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
}
