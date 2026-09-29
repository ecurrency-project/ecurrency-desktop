import { randomUUID } from 'node:crypto'
import { SENSITIVE_SESSION_MS, SensitiveSessionError, type CaptureStatus, type RevokeReason, type SensitivePurpose, type SensitiveSession, type SessionRevoked } from '../../shared/privacy'

export interface SensitiveWindow {
  available(): boolean
  captureStatus(): CaptureStatus
  /** Turn capture protection on and verify it; false when the OS refused. */
  engageShield(): boolean
  /** Capture protection is still verifiably on. */
  shieldIntact(): boolean
  /** Turn capture protection off; only after the renderer confirmed a clean frame. */
  releaseShield(): void
  notify(event: SessionRevoked): void
}
interface Entry {
  window: SensitiveWindow
  generation: number
  active?: SensitiveSession & { purpose: SensitivePurpose; generation: number; monotonicDeadline: number }
  timer?: ReturnType<typeof setTimeout>
}

// Owns permission, never secret data. Deadlines are checked on every access as
// well as by timer; sleep, a blocked event loop or wall-clock rollback cannot
// extend a permission indefinitely. Capture protection is engaged before a
// session exists and survives its revocation until the renderer reports a frame
// without secrets, so ending a session never races the last secret frame.
export class SensitiveSessionManager {
  private readonly entries = new Map<number, Entry>()
  constructor(private readonly now = Date.now, private readonly monotonic = () => performance.now()) {}

  register(owner: number, window: SensitiveWindow): void {
    this.remove(owner)
    this.entries.set(owner, { window, generation: 0 })
  }
  registered(owner: number): boolean { return this.entries.has(owner) }
  generation(owner: number): number | undefined { return this.entries.get(owner)?.generation }
  status(owner: number): CaptureStatus { return this.entries.get(owner)?.window.captureStatus() ?? 'error' }
  hasActive(owner: number): boolean { return this.entries.get(owner)?.active !== undefined }

  begin(owner: number, purpose: SensitivePurpose, acknowledged: boolean): SensitiveSession {
    const entry = this.entries.get(owner)
    const status = this.status(owner)
    if (!entry || !entry.window.available() || status === 'error') throw new SensitiveSessionError()
    if ((status === 'limited' || status === 'unsupported') && !acknowledged) {
      throw new Error('Acknowledge the screen capture limitation before continuing.')
    }
    if (!entry.window.engageShield()) throw new SensitiveSessionError()
    this.revoke(owner, 'replaced')
    const session = { sessionId: randomUUID(), deadline: this.now() + SENSITIVE_SESSION_MS }
    entry.active = { ...session, purpose, generation: entry.generation, monotonicDeadline: this.monotonic() + SENSITIVE_SESSION_MS }
    entry.timer = setTimeout(() => this.revoke(owner, 'expired'), SENSITIVE_SESSION_MS)
    return session
  }

  assert(owner: number, sessionId: string, purpose: SensitivePurpose): void {
    const entry = this.entries.get(owner)
    const active = entry?.active
    if (!entry || !active || active.sessionId !== sessionId || active.purpose !== purpose || active.generation !== entry.generation) {
      throw new SensitiveSessionError()
    }
    if (this.now() >= active.deadline || this.monotonic() >= active.monotonicDeadline) {
      this.revoke(owner, 'expired')
      throw new SensitiveSessionError()
    }
    if (!entry.window.available() || !entry.window.shieldIntact()) {
      this.revoke(owner, 'hidden')
      throw new SensitiveSessionError()
    }
  }

  // The renderer painted a frame without secrets. Ignored while any session is
  // live, so a stale report can never unprotect a newer session.
  cleared(owner: number): void {
    const entry = this.entries.get(owner)
    if (entry && !entry.active) entry.window.releaseShield()
  }
  end(owner: number, sessionId: string): void {
    if (this.entries.get(owner)?.active?.sessionId === sessionId) this.revoke(owner, 'ended')
  }
  revoke(owner: number, reason: RevokeReason): void {
    const entry = this.entries.get(owner)
    if (!entry) return
    const active = entry.active
    delete entry.active
    clearTimeout(entry.timer)
    delete entry.timer
    if (active) entry.window.notify({ sessionId: active.sessionId, reason })
  }
  navigate(owner: number): void {
    this.revoke(owner, 'navigation')
    const entry = this.entries.get(owner)
    if (entry) entry.generation++
  }
  revokeAll(reason: RevokeReason): void {
    for (const owner of this.entries.keys()) this.revoke(owner, reason)
  }
  remove(owner: number): void {
    this.revoke(owner, 'destroyed')
    this.entries.delete(owner)
  }
}
