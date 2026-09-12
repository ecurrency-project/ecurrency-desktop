import { masterKeyFromSeed } from '@qbtc/crypto'
import { activeScheme, addressFromScripthash, exportAccountXpub } from '../../src/main/brand/crypto'
import { describe, expect, it } from 'vitest'
import {
  encodeWatchDescriptor,
  WATCH_DESCRIPTOR_KIND,
  type WatchDescriptor,
  type WatchDescriptorV1,
} from '../../src/main/wallet/watchDescriptor'
import { addressSourceFromStored, parseWatchInput, type StoredWatchSource } from '../../src/main/wallet/watchSource'

const master = masterKeyFromSeed(Uint8Array.from({ length: 64 }, (_, i) => (i * 9 + 2) & 0xff))
const XPUB = exportAccountXpub(master, 'mainnet', 0)
const pq = (fill: number): string => addressFromScripthash(new Uint8Array(32).fill(fill), 'mainnet')
const classical = (fill: number): string => addressFromScripthash(new Uint8Array(20).fill(fill), 'mainnet')

describe('parseWatchInput', () => {
  it('normalizes a bare xpub into a classical-only v2 descriptor on the active scheme', () => {
    const s = parseWatchInput({ kind: 'xpub', xpub: XPUB }, 'mainnet')
    expect(s.type).toBe('descriptor')
    if (s.type === 'descriptor' && s.descriptor.version === 2) {
      expect(s.descriptor.schemes).toEqual([{ scheme: activeScheme().id, classicalXpub: XPUB, falcon: { receive: [], change: [] } }])
    } else {
      throw new Error('expected a v2 descriptor')
    }
  })

  it('accepts a full descriptor and rejects a network mismatch', () => {
    const desc: WatchDescriptor = {
      kind: WATCH_DESCRIPTOR_KIND,
      version: 2,
      network: 'mainnet',
      schemes: [{ scheme: 'fake-v2', classicalXpub: XPUB, falcon: { receive: [pq(1)], change: [] } }],
    }
    expect(parseWatchInput({ kind: 'descriptor', text: encodeWatchDescriptor(desc) }, 'mainnet').type).toBe('descriptor')
    expect(() => parseWatchInput({ kind: 'descriptor', text: encodeWatchDescriptor(desc) }, 'testnet')).toThrow()
  })

  it('accepts a legacy v1 descriptor', () => {
    const v1: WatchDescriptorV1 = {
      kind: WATCH_DESCRIPTOR_KIND,
      version: 1,
      network: 'mainnet',
      classicalXpub: XPUB,
      falcon: { receive: [pq(1)], change: [] },
    }
    const s = parseWatchInput({ kind: 'descriptor', text: encodeWatchDescriptor(v1) }, 'mainnet')
    expect(s.type).toBe('descriptor')
    if (s.type === 'descriptor') expect(s.descriptor.version).toBe(1)
  })

  it('accepts and trims an address list, rejecting invalid ones and empties', () => {
    const s = parseWatchInput({ kind: 'addresses', addresses: [` ${classical(1)} `, pq(2), ''] }, 'mainnet')
    expect(s.type).toBe('addresses')
    if (s.type === 'addresses') expect(s.addresses).toEqual([classical(1), pq(2)])
    expect(() => parseWatchInput({ kind: 'addresses', addresses: ['not-an-address'] }, 'mainnet')).toThrow()
    expect(() => parseWatchInput({ kind: 'addresses', addresses: [] }, 'mainnet')).toThrow()
  })

  it('rejects a bad xpub', () => {
    expect(() => parseWatchInput({ kind: 'xpub', xpub: 'nope' }, 'mainnet')).toThrow()
  })
})

describe('addressSourceFromStored', () => {
  it('builds a descriptor source: per scheme, xpub classical derive branch + Falcon list branch', async () => {
    const stored: StoredWatchSource = {
      type: 'descriptor',
      descriptor: {
        kind: WATCH_DESCRIPTOR_KIND,
        version: 2,
        network: 'mainnet',
        schemes: [
          { scheme: 'fake-v2', classicalXpub: XPUB, falcon: { receive: [pq(1)], change: [] } },
          { scheme: 'fake-v1', classicalXpub: XPUB, falcon: { receive: [], change: [] } },
        ],
      },
    }
    const branches = await addressSourceFromStored(stored).branches()
    expect(branches.map((b) => `${b.scheme}:${b.kind}:${b.algo}`)).toEqual([
      'fake-v2:derive:ecdsa',
      'fake-v2:list:falcon512',
      'fake-v1:derive:ecdsa',
      'fake-v1:list:falcon512',
    ])
  })

  it('builds a v1-descriptor source exactly as before (single section)', async () => {
    const stored: StoredWatchSource = {
      type: 'descriptor',
      descriptor: { kind: WATCH_DESCRIPTOR_KIND, version: 1, network: 'mainnet', classicalXpub: XPUB, falcon: { receive: [pq(1)], change: [] } },
    }
    const branches = await addressSourceFromStored(stored).branches()
    expect(branches.map((b) => `${b.kind}:${b.algo}`)).toEqual(['derive:ecdsa', 'list:falcon512'])
  })

  it('builds an address-list source split by address type', async () => {
    const stored: StoredWatchSource = { type: 'addresses', network: 'mainnet', addresses: [classical(1), pq(2)] }
    const branches = await addressSourceFromStored(stored).branches()
    expect([...branches.map((b) => b.algo)].sort()).toEqual(['ecdsa', 'falcon512'])
    expect(branches.every((b) => b.kind === 'list')).toBe(true)
  })
})
