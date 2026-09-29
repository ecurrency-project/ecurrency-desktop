import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerWalletIpc } from '../../src/main/ipc/router'
import { SensitiveSessionManager } from '../../src/main/privacy/SensitiveSessionManager'
import type { VaultOrchestrator } from '../../src/main/vault/orchestrator'
import { WALLET_CHANNEL, ok, type WalletResponse } from '../../src/shared/protocol'
import { PRIVACY_CHANNEL } from '../../src/shared/privacy'

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, data: unknown) => unknown>())
vi.mock('electron', () => ({ app: { getVersion: () => 'test' }, ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, data: unknown) => unknown) => handlers.set(channel, handler) } }))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup() {
  const manager = new SensitiveSessionManager()
  const frame = { url: 'file:///app/index.html' }
  const event = { sender: { id: 1, mainFrame: frame, isDestroyed: () => false }, senderFrame: frame } as unknown as IpcMainInvokeEvent
  manager.register(1, { available: () => true, captureStatus: () => 'best-effort', engageShield: () => true, shieldIntact: () => true, releaseShield: vi.fn(), notify: vi.fn() })
  const handle = vi.fn(async () => ok('public-test-phrase'))
  const status = vi.fn(async () => 'unlocked' as const)
  registerWalletIpc({ handle } as unknown as VaultOrchestrator, { sessions: manager, isTrustedSender: (url) => url === frame.url, getVaultStatus: status })
  const call = async (data: unknown, ev = event, channel: string = WALLET_CHANNEL): Promise<WalletResponse<unknown>> => await handlers.get(channel)!(ev, data) as WalletResponse<unknown>
  return { manager, handle, status, frame, event, call }
}
beforeEach(() => { vi.useFakeTimers(); handlers.clear() })
afterEach(() => vi.useRealTimers())

describe('privacy and wallet IPC boundary', () => {
  it('refuses unregistered windows, subframes and foreign documents on both channels', async () => {
    const { call, event } = setup()
    const invalid = [
      { ...event, senderFrame: null },
      { ...event, senderFrame: { url: 'file:///app/index.html' } },
      { ...event, sender: { ...event.sender, id: 2 } },
      { ...event, senderFrame: { url: 'file:///other.html' } },
    ]
    for (const ev of invalid) {
      expect((await call({ type: 'vault.getStatus' }, ev as IpcMainInvokeEvent)).ok).toBe(false)
      expect((await call({ type: 'status' }, ev as IpcMainInvokeEvent, PRIVACY_CHANNEL)).ok).toBe(false)
    }
  })
  it('removes the old sessionless reveal and generation entry points', async () => {
    const { call, handle } = setup()
    for (const data of [null, {}, { type: 'vault.revealMnemonic', password: 'pw' }, { type: 'vault.generateMnemonic' }, { type: 'sweep.scan', wif: 'x' }]) {
      expect((await call(data)).ok).toBe(false)
    }
    expect(handle).not.toHaveBeenCalled()
  })
  it('does not issue secret replies after blur/refocus, new document, deadline or context mutation', async () => {
    for (const reason of ['blur', 'navigation', 'expired', 'switch'] as const) {
      const { call, manager, handle } = setup()
      const session = manager.begin(1, 'reveal', true)
      const wait = deferred<ReturnType<typeof ok<string>>>()
      handle.mockReturnValueOnce(wait.promise)
      const pending = call({ type: 'vault.revealMnemonic', password: 'pw', sessionId: session.sessionId })
      await Promise.resolve()
      if (reason === 'navigation') manager.navigate(1)
      else if (reason === 'expired') vi.advanceTimersByTime(120_000)
      else if (reason === 'switch') await call({ type: 'wallets.switch', id: 'other' })
      else manager.revoke(1, 'blur')
      wait.resolve(ok('public-test-phrase'))
      const response = await pending
      expect(response.ok).toBe(false)
      expect(JSON.stringify(response)).not.toContain('public-test-phrase')
      manager.remove(1)
    }
  })
  it('checks focus again after the async vault status read and before KDF', async () => {
    const { call, manager, status, handle } = setup()
    const session = manager.begin(1, 'reveal', true)
    const wait = deferred<'unlocked'>()
    status.mockReturnValueOnce(wait.promise)
    const pending = call({ type: 'vault.revealMnemonic', password: 'pw', sessionId: session.sessionId })
    manager.revoke(1, 'blur'); wait.resolve('unlocked')
    expect((await pending).ok).toBe(false)
    expect(handle).not.toHaveBeenCalled()
  })
  it('accepts onboarding with no vault but never reveals a locked vault', async () => {
    const { call, manager, status } = setup()
    const draft = manager.begin(1, 'onboarding', true)
    expect((await call({ type: 'vault.generateMnemonic', sessionId: draft.sessionId })).ok).toBe(true)
    const reveal = manager.begin(1, 'reveal', true)
    status.mockResolvedValueOnce('locked' as 'unlocked')
    expect((await call({ type: 'vault.revealMnemonic', password: 'pw', sessionId: reveal.sessionId })).ok).toBe(false)
    manager.remove(1)
  })
  it('rejects repeated in-flight reveals and malformed passwords', async () => {
    const { call, manager, handle } = setup()
    const session = manager.begin(1, 'reveal', true)
    const req = { type: 'vault.revealMnemonic', password: 'pw', sessionId: session.sessionId }
    expect((await call({ ...req, password: 12 })).ok).toBe(false)
    const wait = deferred<ReturnType<typeof ok<string>>>()
    handle.mockReturnValueOnce(wait.promise)
    const pending = call(req)
    await Promise.resolve()
    expect((await call(req)).ok).toBe(false)
    wait.resolve(ok('public-test-phrase'))
    expect((await pending).ok).toBe(true)
    manager.remove(1)
  })
})
