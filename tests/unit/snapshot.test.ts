import { describe, expect, it } from 'vitest'
import type { BlobStore, Sealer } from '../../src/main/wallet/meta'
import { SnapshotStore } from '../../src/main/wallet/snapshot'

// An in-memory blob store + a trivial reversible "sealer" (a prefix tag), so the
// test exercises load/merge/open without real crypto. `raw` exposes what landed on
// "disk" to assert it's sealed (never plaintext).
function fakes(): { store: BlobStore; sealer: Sealer; raw: () => string | null } {
  let blob: string | null = null
  const store: BlobStore = {
    read: async () => blob,
    write: async (b) => {
      blob = b
    },
  }
  const sealer: Sealer = {
    sealData: async (plaintext) => `SEALED:${plaintext}`,
    openData: async (b) => {
      if (!b.startsWith('SEALED:')) throw new Error('bad seal')
      return b.slice('SEALED:'.length)
    },
  }
  return { store, sealer, raw: () => blob }
}

describe('SnapshotStore', () => {
  it('returns null when nothing is stored', async () => {
    const { store, sealer } = fakes()
    expect(await new SnapshotStore(store, sealer).load()).toBeNull()
  })

  it('merges slices, persists them sealed, and reads them back on reload', async () => {
    const { store, sealer, raw } = fakes()
    const s = new SnapshotStore(store, sealer)
    await s.merge({ summary: { balanceAtomic: '100', tipHeight: 5, addressCount: 2 } })
    await s.merge({ tokens: [{ id: 'a', amountAtomic: '7', decimals: 6 }] })
    expect(raw()?.startsWith('SEALED:')).toBe(true) // encrypted at rest, never plaintext

    // A fresh store over the same blob sees both merged slices.
    const snap = await new SnapshotStore(store, sealer).load()
    expect(snap?.summary?.balanceAtomic).toBe('100')
    expect(snap?.tokens?.[0]?.id).toBe('a')
  })

  it('treats an unopenable blob (wrong key / corruption) as absent', async () => {
    const { store, sealer } = fakes()
    await store.write('NOT-SEALED-garbage')
    expect(await new SnapshotStore(store, sealer).load()).toBeNull()
  })

  it('reset drops the in-memory copy but keeps the sealed file', async () => {
    const { store, sealer, raw } = fakes()
    const s = new SnapshotStore(store, sealer)
    await s.merge({ summary: { balanceAtomic: '1', tipHeight: 0, addressCount: 0 } })
    s.reset()
    expect(raw()).not.toBeNull() // file persists for the next unlock
    expect((await s.load())?.summary?.balanceAtomic).toBe('1') // reloads from disk
  })
})
