import { afterEach, describe, expect, it, vi } from 'vitest'
import { SensitiveSessionController } from '../../src/renderer/lib/sensitiveSession'
import type { PrivacyApi, SensitiveSession } from '../../src/shared/privacy'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function fixture() {
  let visible = true
  let now = 0
  let serial = 0
  const api: PrivacyApi = {
    getCaptureStatus: vi.fn(async () => 'limited' as const),
    begin: vi.fn(async () => ({ sessionId: String(++serial), deadline: 120_000 })),
    end: vi.fn(async () => {}), cleared: vi.fn(async () => {}), onRevoked: () => () => {},
  }
  const onHide = vi.fn()
  // Frames are "painted" immediately so clean-frame reports are observable.
  const controller = new SensitiveSessionController(api, () => visible, onHide, () => now, (callback) => callback())
  return { api, onHide, controller, visibility: (value: boolean) => { visible = value }, time: (value: number) => { now = value } }
}
afterEach(() => vi.useRealTimers())

describe('renderer async identity', () => {
  it('reports a clean frame after hiding, and after revocations of sessions it does not hold', async () => {
    const { api, controller } = fixture()
    controller.enable(); await controller.refresh(); await controller.begin('reveal')
    expect(api.cleared).not.toHaveBeenCalled()
    controller.stop('blur')
    expect(api.cleared).toHaveBeenCalledTimes(1)
    controller.revoke({ sessionId: 'another-session', reason: 'replaced' })
    expect(api.cleared).toHaveBeenCalledTimes(2)
    controller.disable()
  })
  it('begin resolves true once live, reuses the live session, and refuses a background window', async () => {
    const { api, controller, visibility } = fixture()
    controller.enable(); await controller.refresh()
    expect(await controller.begin('reveal')).toBe(true)
    expect(await controller.begin('reveal')).toBe(true)
    expect(api.begin).toHaveBeenCalledTimes(1)
    controller.stop()
    visibility(false)
    expect(await controller.begin('reveal')).toBe(false)
    expect(controller.snapshot().error).toMatch(/Click inside this window/)
    controller.disable()
  })
  it('ignores an old revocation while begin is pending, but rejects a revoked new session', async () => {
    const { api, controller } = fixture()
    controller.enable(); await controller.refresh()
    const reply = deferred<SensitiveSession>()
    vi.mocked(api.begin).mockReturnValueOnce(reply.promise)
    const starting = controller.begin('reveal')
    controller.revoke({ sessionId: 'old', reason: 'ended' })
    reply.resolve({ sessionId: 'new', deadline: 120_000 }); await starting
    expect(controller.ticket()?.sessionId).toBe('new')
    controller.stop()
    const revoked = deferred<SensitiveSession>()
    vi.mocked(api.begin).mockReturnValueOnce(revoked.promise)
    const other = controller.begin('reveal')
    controller.revoke({ sessionId: 'revoked', reason: 'blur' })
    revoked.resolve({ sessionId: 'revoked', deadline: 120_000 }); await other
    expect(controller.ticket()).toBeNull()
    expect(api.end).toHaveBeenCalledWith('revoked')
    controller.disable()
  })
  it('blur during the capture check does not discard the status or grant a session', async () => {
    const { api, controller } = fixture()
    const reply = deferred<'limited'>()
    vi.mocked(api.getCaptureStatus).mockReturnValue(reply.promise)
    controller.enable(); controller.stop('blur')
    reply.resolve('limited'); await reply.promise
    expect(controller.snapshot().capture).toBe('limited')
    expect(controller.ticket()).toBeNull()
    controller.disable()
  })
  it('discards a begin reply after blur, even after focus returns', async () => {
    const { api, controller, visibility } = fixture()
    controller.enable(); await controller.refresh()
    const pending = deferred<SensitiveSession>()
    vi.mocked(api.begin).mockReturnValueOnce(pending.promise)
    const begin = controller.begin('reveal')
    visibility(false); controller.stop('blur'); visibility(true)
    pending.resolve({ sessionId: 'old', deadline: 120_000 }); await begin
    expect(controller.ticket()).toBeNull()
    expect(api.end).toHaveBeenCalledWith('old')
    controller.disable()
  })
  it('old success/error/finally tickets do not match a reopened session', async () => {
    const { controller } = fixture()
    controller.enable(); await controller.refresh(); await controller.begin('reveal')
    const old = controller.ticket()
    controller.disable(); controller.enable(); await controller.refresh(); await controller.begin('reveal')
    expect(controller.current(old)).toBe(false)
    expect(controller.current(controller.ticket())).toBe(true)
    controller.revoke({ sessionId: old!.sessionId, reason: 'ended' })
    expect(controller.ticket()).not.toBeNull()
    controller.disable()
  })
  it('serializes begin clicks, expires, and never restarts on focus', async () => {
    vi.useFakeTimers()
    const { api, controller, visibility } = fixture()
    controller.enable(); await controller.refresh()
    await Promise.all([controller.begin('seed-input'), controller.begin('seed-input')])
    expect(api.begin).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(120_000)
    visibility(false); visibility(true)
    expect(controller.ticket()).toBeNull()
    expect(api.begin).toHaveBeenCalledTimes(1)
    controller.disable()
  })
  it('refuses hidden entry and responses beyond the deadline without timer delivery', async () => {
    const { api, controller, visibility, time } = fixture()
    controller.enable(); await controller.refresh(); visibility(false)
    await controller.begin('onboarding')
    expect(api.begin).not.toHaveBeenCalled()
    visibility(true); await controller.begin('onboarding')
    const ticket = controller.ticket()
    time(120_001)
    expect(controller.current(ticket)).toBe(false)
    controller.disable()
  })
  it('keeps IPC failure closed and retryable after a StrictMode setup/cleanup cycle', async () => {
    const { api, controller } = fixture()
    controller.enable(); controller.disable(); controller.enable(); await controller.refresh()
    vi.mocked(api.begin).mockRejectedValueOnce(Error('IPC failed'))
    await controller.begin('reveal')
    expect(controller.snapshot().capture).toBe('error')
    expect(controller.ticket()).toBeNull()
    await controller.begin('reveal')
    expect(api.begin).toHaveBeenCalledTimes(1)
    await controller.refresh(); await controller.begin('reveal')
    expect(controller.ticket()).not.toBeNull()
    controller.disable()
  })
  it('a late rejection does not replace the state of a new opening', async () => {
    const { api, controller } = fixture()
    controller.enable(); await controller.refresh()
    const pending = deferred<SensitiveSession>()
    vi.mocked(api.begin).mockReturnValueOnce(pending.promise)
    const old = controller.begin('reveal')
    controller.disable(); controller.enable(); await controller.refresh(); await controller.begin('reveal')
    const current = controller.ticket()
    pending.reject(Error('late failure')); await old
    expect(controller.current(current)).toBe(true)
    expect(controller.snapshot().error).toBeNull()
    controller.disable()
  })
})
