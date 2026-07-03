import { addressFromScripthash, exportAccountXpub, masterKeyFromSeed } from '@qbitcoin/crypto'
import { describe, expect, it } from 'vitest'
import { createAddressListSource, createDescriptorAddressSource, createSeedAddressSource } from '../../src/main/wallet/AddressSource'
import type { WalletMeta } from '../../src/main/wallet/meta'
import { WATCH_DESCRIPTOR_KIND, WATCH_DESCRIPTOR_VERSION, type WatchDescriptor } from '../../src/main/wallet/watchDescriptor'

const master = masterKeyFromSeed(Uint8Array.from({ length: 64 }, (_, i) => (i * 5 + 1) & 0xff))
const XPUB = exportAccountXpub(master, 0)

// Format-valid addresses without Falcon WASM: 32-byte scripthash → PQ, 20-byte → classical.
const pq = (fill: number): string => addressFromScripthash(new Uint8Array(32).fill(fill), 'mainnet')
const classical = (fill: number): string => addressFromScripthash(new Uint8Array(20).fill(fill), 'mainnet')

const descriptor = (falcon: { receive: string[]; change: string[] }): WatchDescriptor => ({
  kind: WATCH_DESCRIPTOR_KIND,
  version: WATCH_DESCRIPTOR_VERSION,
  network: 'mainnet',
  classicalXpub: XPUB,
  falcon,
})

describe('createSeedAddressSource', () => {
  it('exposes a classical and a Falcon derive branch with the meta floors', async () => {
    const meta: WalletMeta = { receiveIndex: 3, changeIndex: 1, pqReceiveIndex: 2, pqChangeIndex: 0 }
    const source = createSeedAddressSource({ getMasterKey: () => master, metaStore: { load: () => Promise.resolve(meta) }, network: 'mainnet' })
    const branches = await source.branches()
    expect(branches.map((b) => b.algo)).toEqual(['ecdsa', 'falcon512'])
    expect(branches.map((b) => b.kind)).toEqual(['derive', 'derive'])
    const ecdsa = branches.find((b) => b.algo === 'ecdsa')
    const falcon = branches.find((b) => b.algo === 'falcon512')
    if (ecdsa?.kind === 'derive') expect(ecdsa.floors).toEqual({ receive: 3, change: 1 })
    if (falcon?.kind === 'derive') expect(falcon.floors).toEqual({ receive: 2, change: 0 })
  })
})

describe('createDescriptorAddressSource', () => {
  it('gap-scans the xpub classically and lists the Falcon addresses by position', async () => {
    const branches = await createDescriptorAddressSource(descriptor({ receive: [pq(1), pq(2)], change: [pq(3)] })).branches()
    const ecdsa = branches.find((b) => b.algo === 'ecdsa')
    const falcon = branches.find((b) => b.algo === 'falcon512')
    expect(ecdsa?.kind).toBe('derive')
    if (ecdsa?.kind === 'derive') expect(ecdsa.floors).toEqual({ receive: 0, change: 0 })
    expect(falcon?.kind).toBe('list')
    if (falcon?.kind === 'list') {
      expect(falcon.addresses).toEqual([
        { chain: 0, index: 0, address: pq(1) },
        { chain: 0, index: 1, address: pq(2) },
        { chain: 1, index: 0, address: pq(3) },
      ])
    }
  })

  it('derives classical addresses from the xpub', async () => {
    const branches = await createDescriptorAddressSource(descriptor({ receive: [], change: [] })).branches()
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
