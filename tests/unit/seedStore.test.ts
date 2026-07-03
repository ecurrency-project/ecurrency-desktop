import { describe, expect, it } from 'vitest'
import { SeedStore, type StoredSeed } from '../../src/main/wallet/seedStore'

// In-memory blob store + a reversible (non-crypto) sealer for tests.
function fakeStore() {
  let blob: string | null = null
  return { read: () => Promise.resolve(blob), write: (b: string) => { blob = b; return Promise.resolve() } }
}
const sealer = {
  sealData: (p: string) => Promise.resolve(`sealed:${Buffer.from(p).toString('base64')}`),
  openData: (b: string) => Promise.resolve(Buffer.from(b.replace(/^sealed:/, ''), 'base64').toString()),
}

describe('SeedStore', () => {
  it('returns null before anything is saved', async () => {
    expect(await new SeedStore(fakeStore(), sealer).load()).toBeNull()
  })

  it('round-trips a sealed seed (mnemonic + passphrase) across instances', async () => {
    const store = fakeStore()
    const seed: StoredSeed = { mnemonic: 'abandon abandon about', passphrase: 'pw' }
    await new SeedStore(store, sealer).save(seed)
    expect(await new SeedStore(store, sealer).load()).toEqual(seed)
  })

  it('seals at rest — the raw blob is not the plaintext', async () => {
    const store = fakeStore()
    await new SeedStore(store, sealer).save({ mnemonic: 'secret words here' })
    const raw = await store.read()
    expect(raw).not.toBeNull()
    expect(raw).not.toContain('secret words')
  })
})
