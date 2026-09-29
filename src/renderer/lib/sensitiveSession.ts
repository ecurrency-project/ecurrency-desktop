import type { CaptureStatus, PrivacyApi, SensitivePurpose, SensitiveSession, SessionRevoked } from '../../shared/privacy'

export interface SensitiveState {
  readonly capture: CaptureStatus | 'loading'
  readonly session: SensitiveSession | null
  readonly preparing: boolean
  readonly error: string | null
}
export interface SensitiveTicket { readonly generation: number; readonly sessionId: string }

// Run after the current DOM has been painted: two animation frames, plus a short
// margin for the OS compositor. Animation frames stop while the window is hidden,
// so capture protection simply stays on until the window is visible again.
export function afterPaint(callback: () => void): void {
  const settle = (): void => { setTimeout(callback, 100) }
  if (typeof requestAnimationFrame !== 'function') { settle(); return }
  requestAnimationFrame(() => requestAnimationFrame(settle))
}

// No React or secret data: identity survives async work, while every close,
// blur and revocation invalidates all callbacks from the previous generation.
export class SensitiveSessionController {
  private generation = 0
  private enabled = false
  private refreshRequest = 0
  private pendingRevocations: Set<string> | null = null
  private readonly listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private state: SensitiveState = { capture: 'loading', session: null, preparing: false, error: null }
  constructor(private readonly api: PrivacyApi, private readonly foreground: () => boolean, private readonly onHide: (reason: string) => void, private readonly now = Date.now, private readonly painted: (callback: () => void) => void = afterPaint) {}
  snapshot = (): SensitiveState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private update(patch: Partial<SensitiveState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  enable(): void { this.enabled = true; void this.refresh() }
  disable(): void { this.enabled = false; this.refreshRequest++; this.stop('closed') }
  async refresh(): Promise<void> {
    const request = ++this.refreshRequest
    this.update({ capture: 'loading', error: null })
    try {
      const capture = await this.api.getCaptureStatus()
      if (!['best-effort', 'limited', 'unsupported', 'error'].includes(capture)) throw new Error('Invalid capture status')
      if (this.enabled && request === this.refreshRequest) this.update({ capture })
    } catch {
      if (this.enabled && request === this.refreshRequest) this.update({ capture: 'error' })
    }
  }
  // Resolves true once a session is live, so callers can continue in the same click.
  async begin(purpose: SensitivePurpose): Promise<boolean> {
    if (!this.enabled || this.state.preparing) return false
    if (this.state.session) return true
    if (this.state.capture === 'loading') return false
    if (this.state.capture === 'error') {
      this.update({ error: PROTECTION_ERROR })
      return false
    }
    if (!this.foreground()) {
      this.update({ error: 'Click inside this window, then try again.' })
      return false
    }
    const generation = ++this.generation
    const revoked = new Set<string>()
    this.pendingRevocations = revoked
    this.update({ preparing: true, error: null })
    try {
      const session = await this.api.begin(purpose, true)
      if (!session || typeof session.sessionId !== 'string' || !session.sessionId || !Number.isFinite(session.deadline)) throw new Error('Invalid session')
      if (!this.enabled || generation !== this.generation || revoked.has(session.sessionId) || !this.foreground() || session.deadline <= this.now()) {
        void this.api.end(session.sessionId).catch(() => {})
        this.reportCleared()
        return false
      }
      this.update({ session })
      this.timer = setTimeout(() => this.stop('expired'), session.deadline - this.now())
      return true
    } catch {
      if (this.enabled && generation === this.generation) this.update({ capture: 'error', error: PROTECTION_ERROR })
      return false
    } finally {
      if (this.pendingRevocations === revoked) this.pendingRevocations = null
      if (this.enabled && generation === this.generation) this.update({ preparing: false })
    }
  }
  ticket(): SensitiveTicket | null {
    const session = this.state.session
    return session && this.enabled && this.foreground() && this.now() < session.deadline
      ? { generation: this.generation, sessionId: session.sessionId } : null
  }
  current(ticket: SensitiveTicket | null): boolean {
    const current = this.ticket()
    return ticket !== null && current !== null && ticket.generation === current.generation && ticket.sessionId === current.sessionId
  }
  revoke(event: SessionRevoked): void {
    if (this.state.session?.sessionId === event.sessionId) this.stop(event.reason)
    else {
      this.pendingRevocations?.add(event.sessionId)
      // Main keeps protection after any revocation until a clean frame is
      // reported; this document shows no secret for that session.
      this.reportCleared()
    }
  }
  stop(reason = 'hidden'): void {
    ++this.generation
    this.pendingRevocations = null
    clearTimeout(this.timer)
    const session = this.state.session
    this.update({ session: null, preparing: false, error: null })
    this.onHide(reason)
    if (session) void this.api.end(session.sessionId).catch(() => {})
    this.reportCleared()
  }
  // Tell main the secret has left the screen, once that frame has been painted.
  private reportCleared(): void {
    this.painted(() => { void this.api.cleared().catch(() => {}) })
  }
}

const PROTECTION_ERROR = "Couldn't turn on screen protection. Try again."
