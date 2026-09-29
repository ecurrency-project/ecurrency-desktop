import { describe, expect, it, vi } from 'vitest'
import { SweepSlot } from '../../src/main/wallet/SweepSlot'
import type { SweepSession } from '../../src/main/wallet/sweep'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function session(scanBalance = async () => ({ balanceAtomic: '0' })) {
  const key = new Uint8Array([1, 2, 3])
  const dispose = vi.fn(() => key.fill(0))
  return { key, dispose, value: { address: 'test-address', scanBalance, dispose } as unknown as SweepSession }
}

describe('sweep cancellation ownership', () => {
  it('wipes a key created after its scan was cancelled', async () => {
    const slot = new SweepSlot()
    const key = session()
    const created = deferred<SweepSession>()
    const scan = slot.scan('old', () => created.promise)
    const rejected = expect(scan).rejects.toThrow(/cancelled/)
    slot.dispose('old'); created.resolve(key.value)
    await rejected
    expect([...key.key]).toEqual([0, 0, 0])
    expect(slot.session).toBeNull()
  })
  it('lock cancels pending balance I/O and an old cleanup does not touch a newer key', async () => {
    const slot = new SweepSlot()
    const balance = deferred<{ balanceAtomic: string }>()
    const old = session(() => balance.promise)
    const scan = slot.scan('old', async () => old.value)
    await Promise.resolve()
    slot.dispose()
    const next = session()
    await slot.scan('new', async () => next.value)
    slot.dispose('old')
    slot.disposeSession(old.value)
    balance.resolve({ balanceAtomic: '123' })
    await expect(scan).rejects.toThrow(/cancelled/)
    expect(slot.session).toBe(next.value)
    expect([...old.key]).toEqual([0, 0, 0])
    expect([...next.key]).toEqual([1, 2, 3])
    slot.dispose()
  })
  it('revoking the input session cancels only a pending scan, not a completed sweep', async () => {
    const slot = new SweepSlot()
    const ready = session()
    await slot.scan('ready', async () => ready.value)
    slot.cancelPending('ready')
    expect(slot.session).toBe(ready.value)
    slot.dispose('ready')
    expect(slot.session).toBeNull()
  })
  it('scan failure wipes material and permits an explicit new scan', async () => {
    const slot = new SweepSlot()
    const failed = session(async () => { throw new Error('offline') })
    await expect(slot.scan('failed', async () => failed.value)).rejects.toThrow('offline')
    expect([...failed.key]).toEqual([0, 0, 0])
    expect(slot.session).toBeNull()
    const next = session()
    await slot.scan('next', async () => next.value)
    slot.dispose()
  })
})
