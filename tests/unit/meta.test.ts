import { META_V1_SCHEME_ID } from '../../src/main/brand/crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_META, indicesFor, WalletMetaStore, withIndices, ZERO_INDICES, type WalletMeta } from '../../src/main/wallet/meta'

// In-memory blob store + identity sealer (sealing itself is the Vault's job).
function fakes(initial: string | null = null) {
  let blob = initial
  const store = {
    read: async () => blob,
    write: async (b: string) => {
      blob = b
    },
  }
  const sealer = { sealData: async (p: string) => p, openData: async (b: string) => b }
  return { store, sealer, readBlob: () => blob }
}

describe('WalletMetaStore', () => {
  it('returns empty v2 defaults when nothing is stored', async () => {
    const { store, sealer } = fakes()
    expect(await new WalletMetaStore(store, sealer).load()).toEqual(DEFAULT_META)
  })

  it('round-trips v2 meta', async () => {
    const { store, sealer } = fakes()
    const metaStore = new WalletMetaStore(store, sealer)
    const meta: WalletMeta = {
      version: 2,
      schemes: {
        'fake-v1': { receiveIndex: 3, changeIndex: 1, pqReceiveIndex: 2, pqChangeIndex: 0 },
        'fake-v2': { receiveIndex: 1, changeIndex: 0, pqReceiveIndex: 0, pqChangeIndex: 0 },
      },
    }
    await metaStore.save(meta)
    expect(await metaStore.load()).toEqual(meta)
  })

  it('migrates a v1 (flat) blob: its indices belong to the pre-multi-scheme scheme', async () => {
    // Exactly what a pre-migration wallet has on disk.
    const { store, sealer } = fakes(JSON.stringify({ receiveIndex: 7, changeIndex: 2, pqReceiveIndex: 5, pqChangeIndex: 1 }))
    const meta = await new WalletMetaStore(store, sealer).load()
    expect(meta).toEqual({
      version: 2,
      schemes: { [META_V1_SCHEME_ID]: { receiveIndex: 7, changeIndex: 2, pqReceiveIndex: 5, pqChangeIndex: 1 } },
    })
    // The (new) active scheme starts from scratch — v1 floors must NOT leak onto it.
    expect(indicesFor(meta, 'some-new-scheme')).toEqual(ZERO_INDICES)
  })

  it('attributes a v1 blob to an injected owner scheme (fake-scheme test hook)', async () => {
    const { store, sealer } = fakes(JSON.stringify({ receiveIndex: 4, changeIndex: 0, pqReceiveIndex: 0, pqChangeIndex: 0 }))
    const meta = await new WalletMetaStore(store, sealer, 'fake-v1').load()
    expect(indicesFor(meta, 'fake-v1').receiveIndex).toBe(4)
    expect(indicesFor(meta, META_V1_SCHEME_ID === 'fake-v1' ? 'other' : META_V1_SCHEME_ID)).toEqual(ZERO_INDICES)
  })

  it('normalizes malformed indices to zero (both layouts)', async () => {
    const flat = fakes(JSON.stringify({ receiveIndex: -1, changeIndex: 'x', pqReceiveIndex: 1.5 }))
    expect(await new WalletMetaStore(flat.store, flat.sealer, 'fake-v1').load()).toEqual({
      version: 2,
      schemes: { 'fake-v1': ZERO_INDICES },
    })
    const nested = fakes(JSON.stringify({ version: 2, schemes: { 'fake-v2': { receiveIndex: 2, changeIndex: -3 } } }))
    expect(await new WalletMetaStore(nested.store, nested.sealer).load()).toEqual({
      version: 2,
      schemes: { 'fake-v2': { receiveIndex: 2, changeIndex: 0, pqReceiveIndex: 0, pqChangeIndex: 0 } },
    })
  })
})

describe('indicesFor / withIndices', () => {
  it('defaults an untouched scheme to zeros and replaces immutably', () => {
    const meta = withIndices(DEFAULT_META, 'fake-v2', { ...ZERO_INDICES, receiveIndex: 9 })
    expect(indicesFor(meta, 'fake-v2').receiveIndex).toBe(9)
    expect(indicesFor(meta, 'fake-v1')).toEqual(ZERO_INDICES)
    expect(DEFAULT_META.schemes).toEqual({}) // untouched
  })
})
