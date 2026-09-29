import { afterEach, describe, expect, it, vi } from 'vitest'
import { SensitiveSessionManager } from '../../src/main/privacy/SensitiveSessionManager'
import { handlePrivacy } from '../../src/main/privacy/ipc'
import { createCaptureShield } from '../../src/main/privacy/captureProtection'
import { SENSITIVE_SESSION_MS, type CaptureStatus } from '../../src/shared/privacy'

function fixture(status: CaptureStatus = 'best-effort') {
  let available = true
  let now = 1000
  let monotonic = 0
  let shield = true
  const notify = vi.fn()
  const engage = vi.fn(() => shield)
  const release = vi.fn()
  const manager = new SensitiveSessionManager(() => now, () => monotonic)
  manager.register(1, { available: () => available, captureStatus: () => status, engageShield: engage, shieldIntact: () => shield, releaseShield: release, notify })
  return {
    manager, notify, engage, release,
    hide: () => { available = false }, time: (value: number) => { now = value }, monotonic: (value: number) => { monotonic = value },
    breakShield: () => { shield = false },
  }
}
afterEach(() => vi.useRealTimers())

describe('main sensitive permission', () => {
  it.each(['limited', 'unsupported'] as const)('requires acknowledgment on every %s session', (status) => {
    const { manager } = fixture(status)
    expect(() => manager.begin(1, 'seed-input', false)).toThrow(/Acknowledge/)
    const first = manager.begin(1, 'seed-input', true)
    manager.end(1, first.sessionId)
    expect(() => manager.begin(1, 'seed-input', false)).toThrow()
    manager.remove(1)
  })
  it('refuses absent windows, capture failures and hidden windows', () => {
    const failed = fixture('error')
    expect(() => failed.manager.begin(1, 'reveal', true)).toThrow()
    const { manager, hide } = fixture()
    expect(() => manager.begin(2, 'reveal', true)).toThrow()
    hide()
    expect(() => manager.begin(1, 'reveal', true)).toThrow()
  })
  it('binds owner, purpose and id, and old cleanup cannot revoke its replacement', () => {
    const { manager, notify } = fixture()
    const first = manager.begin(1, 'reveal', true)
    expect(() => manager.assert(2, first.sessionId, 'reveal')).toThrow()
    expect(() => manager.assert(1, first.sessionId, 'onboarding')).toThrow()
    const next = manager.begin(1, 'reveal', true)
    manager.end(1, first.sessionId)
    expect(() => manager.assert(1, next.sessionId, 'reveal')).not.toThrow()
    expect(notify).toHaveBeenCalledWith({ sessionId: first.sessionId, reason: 'replaced' })
    manager.end(1, next.sessionId)
    manager.end(1, next.sessionId)
    expect(notify).toHaveBeenCalledTimes(2)
  })
  it('rejects elapsed wall time even before the timer runs (sleep/resume)', () => {
    const { manager, time } = fixture()
    const session = manager.begin(1, 'onboarding', true)
    time(session.deadline)
    expect(() => manager.assert(1, session.sessionId, 'onboarding')).toThrow()
  })
  it('does not extend a session on wall-clock rollback', () => {
    const { manager, time, monotonic } = fixture()
    const session = manager.begin(1, 'reveal', true)
    time(0); monotonic(SENSITIVE_SESSION_MS)
    expect(() => manager.assert(1, session.sessionId, 'reveal')).toThrow()
  })
  it('expires proactively and invalidates a previous document', () => {
    vi.useFakeTimers()
    const { manager, notify } = fixture()
    const session = manager.begin(1, 'reveal', true)
    vi.advanceTimersByTime(SENSITIVE_SESSION_MS)
    expect(notify).toHaveBeenCalledWith({ sessionId: session.sessionId, reason: 'expired' })
    const next = manager.begin(1, 'seed-input', true)
    manager.navigate(1)
    expect(manager.generation(1)).toBe(1)
    expect(() => manager.assert(1, next.sessionId, 'seed-input')).toThrow()
  })
  it('validates privacy IPC values instead of trusting the types', () => {
    const { manager } = fixture()
    for (const value of [null, {}, { type: 'begin', purpose: 'admin', acknowledged: true }, { type: 'begin', purpose: 'confirmation', acknowledged: true }, { type: 'begin', purpose: 'reveal', acknowledged: 'yes' }, { type: 'end', sessionId: 1 }]) {
      expect(handlePrivacy(manager, 1, value).ok).toBe(false)
    }
    expect(handlePrivacy(manager, 1, { type: 'status' })).toEqual({ ok: true, value: 'best-effort' })
  })
})

describe('session-scoped capture shield', () => {
  function captureWindow(protectedFlag = true) {
    return { setContentProtection: vi.fn(), isContentProtected: vi.fn(() => protectedFlag) }
  }
  it.each([['win32', 'best-effort'], ['darwin', 'limited'], ['linux', 'unsupported']] as const)('reports the limits of %s honestly', (platform, expected) => {
    expect(createCaptureShield(captureWindow(), platform).status).toBe(expected)
  })
  it('is off until engaged, verifies engagement, and releases only what it engaged', () => {
    const win = captureWindow()
    const shield = createCaptureShield(win, 'darwin')
    expect(win.setContentProtection).not.toHaveBeenCalled()
    shield.release()
    expect(win.setContentProtection).not.toHaveBeenCalled()
    expect(shield.engage()).toBe(true)
    expect(shield.intact()).toBe(true)
    expect(win.setContentProtection).toHaveBeenLastCalledWith(true)
    shield.release()
    expect(win.setContentProtection).toHaveBeenLastCalledWith(false)
    expect(shield.intact()).toBe(false)
  })
  it('fails closed when the OS refuses or does not report the flag', () => {
    expect(createCaptureShield({ setContentProtection: () => { throw Error('OS error') }, isContentProtected: () => true }, 'win32').engage()).toBe(false)
    const unverified = createCaptureShield(captureWindow(false), 'win32')
    expect(unverified.engage()).toBe(false)
    expect(unverified.intact()).toBe(false)
  })
  it('stays protected if turning the flag off fails', () => {
    const win = { setContentProtection: vi.fn((on: boolean) => { if (!on) throw Error('OS error') }), isContentProtected: () => true }
    const shield = createCaptureShield(win, 'win32')
    shield.engage()
    shield.release()
    expect(shield.intact()).toBe(true)
  })
  it('has nothing to engage where the OS offers no such API', () => {
    const win = captureWindow()
    const shield = createCaptureShield(win, 'linux')
    expect(shield.engage()).toBe(true)
    expect(shield.intact()).toBe(true)
    shield.release()
    expect(win.setContentProtection).not.toHaveBeenCalled()
  })
})

describe('shield ownership by sessions', () => {
  it('engages before a session exists and refuses the session when protection fails', () => {
    const ok = fixture()
    ok.manager.begin(1, 'reveal', true)
    expect(ok.engage).toHaveBeenCalledTimes(1)
    const refused = fixture()
    refused.breakShield()
    expect(() => refused.manager.begin(1, 'reveal', true)).toThrow()
    expect(refused.manager.hasActive(1)).toBe(false)
  })
  it('keeps protection through revocation until a clean frame is reported without a live session', () => {
    const { manager, release } = fixture()
    const first = manager.begin(1, 'reveal', true)
    manager.revoke(1, 'blur')
    expect(release).not.toHaveBeenCalled()
    const second = manager.begin(1, 'reveal', true)
    manager.cleared(1)
    expect(release).not.toHaveBeenCalled()
    manager.end(1, second.sessionId)
    manager.cleared(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(() => manager.assert(1, first.sessionId, 'reveal')).toThrow()
  })
  it('revokes a session whose protection no longer holds', () => {
    const { manager, breakShield, notify } = fixture()
    const session = manager.begin(1, 'reveal', true)
    breakShield()
    expect(() => manager.assert(1, session.sessionId, 'reveal')).toThrow()
    expect(notify).toHaveBeenCalledWith({ sessionId: session.sessionId, reason: 'hidden' })
  })
})
