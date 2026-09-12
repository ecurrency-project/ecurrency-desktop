import { masterKeyFromSeed, type DerivationScheme } from '@qbtc/crypto'
import { activeScheme, addressFromScripthash, DERIVATION_SCHEMES, exportAccountXpub } from '../../src/main/brand/crypto'
import { describe, expect, it } from 'vitest'
import { createAddressListSource, createDescriptorAddressSource, createSeedAddressSource } from '../../src/main/wallet/AddressSource'
import type { WalletMeta } from '../../src/main/wallet/meta'
import { WATCH_DESCRIPTOR_KIND, type WatchDescriptor } from '../../src/main/wallet/watchDescriptor'

const master = masterKeyFromSeed(Uint8Array.from({ length: 64 }, (_, i) => (i * 5 + 1) & 0xff))
const XPUB = exportAccountXpub(master, 'mainnet', 0)

// Format-valid addresses without Falcon WASM: 32-byte scripthash → PQ, 20-byte → classical.
const pq = (fill: number): string => addressFromScripthash(new Uint8Array(32).fill(fill), 'mainnet')
const classical = (fill: number): string => addressFromScripthash(new Uint8Array(20).fill(fill), 'mainnet')

// Fake registry entries for exercising multi-scheme mechanics without touching
// the real (brand) registry.
const fakeScheme = (id: string, coinType: number, status: 'active' | 'legacy'): DerivationScheme => ({
  id,
  coinType,
  label: id,
  status,
  pathTemplate: (account, change, index) => `m/44'/${coinType}'/${account}'/${change}/${index}`,
})

const descriptorV2 = (schemes: readonly { scheme: string; falcon: { receive: string[]; change: string[] } }[]): WatchDescriptor => ({
  kind: WATCH_DESCRIPTOR_KIND,
  version: 2,
  network: 'mainnet',
  schemes: schemes.map((s) => ({ scheme: s.scheme, classicalXpub: XPUB, falcon: s.falcon })),
})

describe('createSeedAddressSource', () => {
  const meta: WalletMeta = {
    version: 2,
    schemes: { [activeScheme().id]: { receiveIndex: 3, changeIndex: 1, pqReceiveIndex: 2, pqChangeIndex: 0 } },
  }

  it('exposes a classical and a Falcon derive branch per registry scheme, active first, with the meta floors', async () => {
    // Registry-agnostic: brands differ in how many schemes they carry, so pin
    // the PER-SCHEME shape (2 branches each) and the active scheme's floors.
    const source = createSeedAddressSource({ getMasterKey: () => master, metaStore: { load: () => Promise.resolve(meta) }, network: 'mainnet' })
    const branches = await source.branches()
    expect(branches).toHaveLength(2 * DERIVATION_SCHEMES.length)
    // The active scheme's pair comes first (Receive/branch pickers rely on it).
    expect(branches.slice(0, 2).map((b) => b.scheme)).toEqual([activeScheme().id, activeScheme().id])
    const active = branches.filter((b) => b.scheme === activeScheme().id)
    expect(active.map((b) => `${b.kind}:${b.algo}`)).toEqual(['derive:ecdsa', 'derive:falcon512'])
    const [ecdsa, falcon] = active
    if (ecdsa?.kind === 'derive') expect(ecdsa.floors).toEqual({ receive: 3, change: 1 })
    if (falcon?.kind === 'derive') expect(falcon.floors).toEqual({ receive: 2, change: 0 })
  })

  it('exposes branches for EVERY scheme (active first), each with its own floors', async () => {
    const v2 = fakeScheme('fake-v2', 8128, 'active')
    const v1 = fakeScheme('fake-v1', 999, 'legacy')
    const multiMeta: WalletMeta = {
      version: 2,
      schemes: {
        'fake-v1': { receiveIndex: 5, changeIndex: 2, pqReceiveIndex: 4, pqChangeIndex: 1 },
        'fake-v2': { receiveIndex: 1, changeIndex: 0, pqReceiveIndex: 0, pqChangeIndex: 0 },
      },
    }
    const source = createSeedAddressSource({
      getMasterKey: () => master,
      metaStore: { load: () => Promise.resolve(multiMeta) },
      network: 'mainnet',
      schemes: [v2, v1],
    })
    const branches = await source.branches()
    expect(branches.map((b) => `${b.scheme}:${b.algo}`)).toEqual([
      'fake-v2:ecdsa',
      'fake-v2:falcon512',
      'fake-v1:ecdsa',
      'fake-v1:falcon512',
    ])
    const floors = branches.map((b) => (b.kind === 'derive' ? b.floors : null))
    expect(floors).toEqual([
      { receive: 1, change: 0 },
      { receive: 0, change: 0 },
      { receive: 5, change: 2 },
      { receive: 4, change: 1 },
    ])
  })

  it('derives DIFFERENT classical addresses on different schemes (distinct coin_type paths)', async () => {
    const v2 = fakeScheme('fake-v2', 8128, 'active')
    const v1 = fakeScheme('fake-v1', 999, 'legacy')
    const source = createSeedAddressSource({
      getMasterKey: () => master,
      metaStore: { load: () => Promise.resolve({ version: 2, schemes: {} } as WalletMeta) },
      network: 'mainnet',
      schemes: [v2, v1],
    })
    const branches = await source.branches()
    const classicalBranches = branches.filter((b) => b.algo === 'ecdsa')
    if (classicalBranches[0]?.kind !== 'derive' || classicalBranches[1]?.kind !== 'derive') throw new Error('expected derive branches')
    const [a, b] = await Promise.all([classicalBranches[0].derive(0, 0), classicalBranches[1].derive(0, 0)])
    expect(a).not.toBe(b)
  })
})

describe('createDescriptorAddressSource', () => {
  it('gap-scans the xpub classically and lists the Falcon addresses by position (v2)', async () => {
    const descriptor = descriptorV2([{ scheme: 'fake-v2', falcon: { receive: [pq(1), pq(2)], change: [pq(3)] } }])
    const branches = await createDescriptorAddressSource(descriptor).branches()
    const ecdsa = branches.find((b) => b.algo === 'ecdsa')
    const falcon = branches.find((b) => b.algo === 'falcon512')
    expect(ecdsa?.kind).toBe('derive')
    expect(ecdsa?.scheme).toBe('fake-v2')
    if (ecdsa?.kind === 'derive') expect(ecdsa.floors).toEqual({ receive: 0, change: 0 })
    expect(falcon?.kind).toBe('list')
    expect(falcon?.scheme).toBe('fake-v2')
    if (falcon?.kind === 'list') {
      expect(falcon.addresses).toEqual([
        { chain: 0, index: 0, address: pq(1) },
        { chain: 0, index: 1, address: pq(2) },
        { chain: 1, index: 0, address: pq(3) },
      ])
    }
  })

  it('exposes branches per scheme section, in section order (active first)', async () => {
    const descriptor = descriptorV2([
      { scheme: 'fake-v2', falcon: { receive: [], change: [] } },
      { scheme: 'fake-v1', falcon: { receive: [pq(7)], change: [] } },
    ])
    const branches = await createDescriptorAddressSource(descriptor).branches()
    expect(branches.map((b) => `${b.scheme}:${b.kind}:${b.algo}`)).toEqual([
      'fake-v2:derive:ecdsa',
      'fake-v2:list:falcon512',
      'fake-v1:derive:ecdsa',
      'fake-v1:list:falcon512',
    ])
  })

  it('accepts a v1 descriptor as the pre-multi-scheme single section', async () => {
    const v1: WatchDescriptor = {
      kind: WATCH_DESCRIPTOR_KIND,
      version: 1,
      network: 'mainnet',
      classicalXpub: XPUB,
      falcon: { receive: [pq(1)], change: [] },
    }
    const branches = await createDescriptorAddressSource(v1).branches()
    expect(branches.map((b) => `${b.kind}:${b.algo}`)).toEqual(['derive:ecdsa', 'list:falcon512'])
  })

  it('derives classical addresses from the xpub', async () => {
    const branches = await createDescriptorAddressSource(descriptorV2([{ scheme: 'fake-v2', falcon: { receive: [], change: [] } }])).branches()
    const ecdsa = branches.find((b) => b.algo === 'ecdsa')
    if (ecdsa?.kind !== 'derive') throw new Error('expected a classical derive branch')
    expect(typeof (await ecdsa.derive(0, 0))).toBe('string')
  })
})

describe('createAddressListSource', () => {
  it('splits a bare list into classical and Falcon list branches', async () => {
    const branches = await createAddressListSource([classical(1), pq(2), classical(3)]).branches()
    expect(branches).toHaveLength(2)
    const ecdsa = branches.find((b) => b.algo === 'ecdsa')
    const falcon = branches.find((b) => b.algo === 'falcon512')
    expect(ecdsa?.kind).toBe('list')
    if (ecdsa?.kind === 'list') expect(ecdsa.addresses.map((a) => a.address)).toEqual([classical(1), classical(3)])
    if (falcon?.kind === 'list') expect(falcon.addresses.map((a) => a.address)).toEqual([pq(2)])
  })
})
