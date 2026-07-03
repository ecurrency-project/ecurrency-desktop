import { describe, expect, it } from 'vitest'
import { KeyStore, type StoredKey } from '../../src/main/wallet/keyStore'

// In-memory blob store + a reversible (non-crypto) sealer for tests.
function fakeStore() {
  let blob: string | null = null
  return { read: () => Promise.resolve(blob), write: (b: string) => { blob = b; return Promise.resolve() } }
}
const sealer = {
  sealData: (p: string) => Promise.resolve(`sealed:${Buffer.from(p).toString('base64')}`),
  openData: (b: string) => Promise.resolve(Buffer.from(b.replace(/^sealed:/, ''), 'base64').toString()),
}

const KEY: StoredKey = { wif: '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ', algo: 'ecdsa', address: 'ECexample' }

describe('KeyStore', () => {
  it('returns null before anything is saved', async () => {
    expect(await new KeyStore(fakeStore(), sealer).load()).toBeNull()
  })

  it('round-trips a sealed key (wif + algo + address) across instances', async () => {
    const store = fakeStore()
    await new KeyStore(store, sealer).save(KEY)
    expect(await new KeyStore(store, sealer).load()).toEqual(KEY)
  })

  it('seals at rest — the raw blob does not contain the WIF', async () => {
    const store = fakeStore()
    await new KeyStore(store, sealer).save(KEY)
    const raw = await store.read()
    expect(raw).not.toBeNull()
    expect(raw).not.toContain(KEY.wif)
  })

  it('reset drops the memory cache but not the disk copy', async () => {
    const store = fakeStore()
    const ks = new KeyStore(store, sealer)
    await ks.save(KEY)
    ks.reset()
    expect(await ks.load()).toEqual(KEY)
  })
})
