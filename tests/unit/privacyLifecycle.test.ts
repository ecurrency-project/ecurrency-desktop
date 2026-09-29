import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SensitiveSessionManager } from '../../src/main/privacy/SensitiveSessionManager'
import { protectSensitiveWindow } from '../../src/main/privacy/windowLifecycle'

function setup() {
  const contents = Object.assign(new EventEmitter(), { id: 1, send: vi.fn(), reload: vi.fn(), isDestroyed: () => false })
  let visible = true
  const win = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false, isVisible: () => visible, isFocused: () => true, isMinimized: () => false,
    setContentProtection: vi.fn(), isContentProtected: () => true,
    hide: vi.fn(() => { visible = false; win.emit('hide') }),
    show: vi.fn(() => { visible = true; win.emit('show') }),
  })
  const sessions = new SensitiveSessionManager()
  const lock = vi.fn()
  const cancel = vi.fn()
  const failed = vi.fn()
  // An explicit platform with a real capture API keeps these checks meaningful on any CI OS.
  const show = protectSensitiveWindow(win as unknown as BrowserWindow, sessions, lock, cancel, failed, 'darwin')
  return { win, contents, sessions, show, lock, cancel, failed }
}
afterEach(() => vi.useRealTimers())

describe('native window lifecycle', () => {
  it('ordinary screens stay capturable: nothing is protected before a session', () => {
    const { win } = setup()
    expect(win.setContentProtection).not.toHaveBeenCalled()
  })
  it.each(['blur', 'hide', 'minimize'])('revokes on %s and keeps protection until the renderer reports a clean frame', (event) => {
    vi.useFakeTimers()
    const { win, sessions, cancel } = setup()
    const session = sessions.begin(1, 'reveal', true)
    expect(win.setContentProtection).toHaveBeenLastCalledWith(true)
    win.emit(event)
    expect(() => sessions.assert(1, session.sessionId, 'reveal')).toThrow()
    expect(cancel).toHaveBeenCalledWith(session.sessionId)
    expect(win.setContentProtection).not.toHaveBeenCalledWith(false)
    sessions.cleared(1)
    expect(win.setContentProtection).toHaveBeenLastCalledWith(false)
  })
  it('closing the window revokes the session and locks the vault', () => {
    vi.useFakeTimers()
    const { win, sessions, cancel, lock } = setup()
    const session = sessions.begin(1, 'reveal', true)
    win.emit('closed')
    expect(() => sessions.assert(1, session.sessionId, 'reveal')).toThrow()
    expect(cancel).toHaveBeenCalledWith(session.sessionId)
    expect(lock).toHaveBeenCalled()
  })
  it('a frozen secret frame stays hidden and protected until a fresh document reports a clean frame', () => {
    vi.useFakeTimers()
    const { win, contents, sessions, show, lock } = setup()
    sessions.begin(1, 'reveal', true)
    win.emit('blur'); win.emit('unresponsive')
    expect(win.isVisible()).toBe(false)
    expect(lock).toHaveBeenCalled()
    // The quarantined frame may still hold the secret: a report cannot lift protection.
    sessions.cleared(1)
    expect(win.setContentProtection).not.toHaveBeenCalledWith(false)
    show()
    expect(contents.reload).toHaveBeenCalledTimes(1)
    expect(win.isVisible()).toBe(false)
    // Native activation must not expose the old surface either.
    win.show()
    expect(win.isVisible()).toBe(false)
    contents.emit('did-finish-load')
    expect(win.isVisible()).toBe(true)
    expect(sessions.hasActive(1)).toBe(false)
    sessions.cleared(1)
    expect(win.setContentProtection).toHaveBeenLastCalledWith(false)
  })
  it('navigation/crash invalidates the document and only a reload can show a crashed window', () => {
    vi.useFakeTimers()
    const { contents, win, sessions, show } = setup()
    sessions.begin(1, 'reveal', true)
    contents.emit('did-start-navigation', {}, 'file:///app/index.html', false, true)
    expect(sessions.generation(1)).toBe(1)
    contents.emit('render-process-gone')
    expect(win.isVisible()).toBe(false)
    expect(contents.reload).toHaveBeenCalledTimes(1)
    show()
    expect(contents.reload).toHaveBeenCalled()
    expect(win.isVisible()).toBe(false)
  })
  it('offers recovery after another crash without looping, and permits a retry', () => {
    const { contents, win, show, failed } = setup()
    contents.emit('render-process-gone')
    contents.emit('render-process-gone')
    expect(contents.reload).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(win.isVisible()).toBe(false)
    show()
    expect(contents.reload).toHaveBeenCalledTimes(2)
    contents.emit('did-finish-load')
    expect(win.isVisible()).toBe(true)
  })
  it('a failed main-frame reload stays hidden and can be retried', () => {
    const { contents, win, show, failed } = setup()
    contents.emit('render-process-gone')
    contents.emit('did-fail-load', {}, -2, 'Failed', 'file:///app/index.html', false)
    expect(failed).not.toHaveBeenCalled()
    contents.emit('did-fail-load', {}, -2, 'Failed', 'file:///app/index.html', true)
    expect(failed).toHaveBeenCalledTimes(1)
    contents.emit('did-finish-load')
    expect(win.isVisible()).toBe(false)
    show()
    contents.emit('did-finish-load')
    expect(win.isVisible()).toBe(true)
  })
})
