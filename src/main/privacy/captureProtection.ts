import type { CaptureStatus } from '../../shared/privacy'

interface CaptureWindow {
  setContentProtection(enabled: boolean): void
  isContentProtected(): boolean
}

export interface CaptureShield {
  /** What this platform can offer. The shield itself is off outside sensitive sessions. */
  readonly status: CaptureStatus
  /** Turn protection on and verify it took effect. False when the OS refused. */
  engage(): boolean
  /** True while protection is verifiably on (always true where the OS has no such API). */
  intact(): boolean
  /** Turn protection off. Callers do this only after a frame without secrets was painted. */
  release(): void
}

// Protection covers sensitive sessions only, so ordinary screens stay capturable.
// It is engaged before a session is granted and released only once the renderer
// confirms the secret is gone from screen; any failure keeps it on.
export function createCaptureShield(window: CaptureWindow, platform: string): CaptureShield {
  const supported = platform === 'win32' || platform === 'darwin'
  const status: CaptureStatus = platform === 'win32' ? 'best-effort' : platform === 'darwin' ? 'limited' : 'unsupported'
  let engaged = false
  const verified = (): boolean => {
    try { return window.isContentProtected() } catch { return false }
  }
  return {
    status,
    engage: () => {
      if (!supported) return true
      try { window.setContentProtection(true) } catch { return false }
      engaged = verified()
      return engaged
    },
    intact: () => !supported || (engaged && verified()),
    release: () => {
      if (!supported || !engaged) return
      try {
        window.setContentProtection(false)
        engaged = false
      } catch { /* Staying protected is the safe failure. */ }
    },
  }
}
