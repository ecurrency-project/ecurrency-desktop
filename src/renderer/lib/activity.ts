import { wallet } from './wallet'

// Idle-autolock activity reporter.
//
// The main-process Vault locks after a span with no activity, where "activity"
// is an explicit signal — NOT internal key access and NOT the background SWR
// poll (those deliberately don't extend the unlock window, or a polling renderer
// would keep the wallet open forever). So genuine user interaction is reported
// from here, and only that: the wallet stays unlocked while the user is present
// and locks once they step away.

// Report at most once per window. An active user fires far more events than the
// lock needs, and each report is an IPC round-trip; this must stay well under the
// vault's autolock interval so an active session never locks out from under them.
const THROTTLE_MS = 25_000

// Real user-interaction events. Pointer/touch covers mouse + trackpad + touch;
// move/wheel catch reading/scrolling without clicking; keydown catches typing.
const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

// Begin reporting user activity to main. Returns a cleanup that detaches every
// listener — call it when the wallet locks or the view unmounts. Mount this only
// while unlocked (see App), so a locked/booting renderer reports nothing.
export function startActivityReporting(): () => void {
  let last = 0
  const onActivity = (): void => {
    const now = Date.now()
    if (now - last < THROTTLE_MS) return
    last = now
    // Fire-and-forget: a failed ping just means a slightly earlier autolock.
    void wallet.noteActivity().catch(() => {})
  }
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  for (const type of EVENTS) window.addEventListener(type, onActivity, opts)
  return () => {
    for (const type of EVENTS) window.removeEventListener(type, onActivity, opts)
  }
}
