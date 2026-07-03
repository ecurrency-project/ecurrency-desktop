import { addressFromScripthash, exportAccountXpub, masterKeyFromSeed } from '@qbitcoin/crypto'
import { describe, expect, it } from 'vitest'
import {
  encodeWatchDescriptor,
  WATCH_DESCRIPTOR_KIND,
  WATCH_DESCRIPTOR_VERSION,
  type WatchDescriptor,
} from '../../src/main/wallet/watchDescriptor'
import { addressSourceFromStored, parseWatchInput, type StoredWatchSource } from '../../src/main/wallet/watchSource'

const master = masterKeyFromSeed(Uint8Array.from({ length: 64 }, (_, i) => (i * 9 + 2) & 0xff))
const XPUB = exportAccountXpub(master, 0)
const pq = (fill: number): string => addressFromScripthash(new Uint8Array(32).fill(fill), 'mainnet')
const classical = (fill: number): string => addressFromScripthash(new Uint8Array(20).fill(fill), 'mainnet')

describe('parseWatchInput', () => {
  it('normalizes a bare xpub into a classical-only descriptor', () => {
    const s = parseWatchInput({ kind: 'xpub', xpub: XPUB }, 'mainnet')
    expect(s.type).toBe('descriptor')
    if (s.type === 'descriptor') {
      expect(s.descriptor.classicalXpub).toBe(XPUB)
      expect(s.descriptor.falcon).toEqual({ receive: [], change: [] })
    }
  })

  it('accepts a full descriptor and rejects a network mismatch', () => {
    const desc: WatchDescriptor = {
      kind: WATCH_DESCRIPTOR_KIND,
      version: WATCH_DESCRIPTOR_VERSION,
      network: 'mainnet',
      classicalXpub: XPUB,
      falcon: { receive: [pq(1)], change: [] },
    }
    expect(parseWatchInput({ kind: 'descriptor', text: encodeWatchDescriptor(desc) }, 'mainnet').type).toBe('descriptor')
    expect(() => parseWatchInput({ kind: 'descriptor', text: encodeWatchDescriptor(desc) }, 'testnet')).toThrow()
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
  it('builds a descriptor source: xpub classical derive branch + Falcon list branch', async () => {
    const stored: StoredWatchSource = {
      type: 'descriptor',
      descriptor: { kind: WATCH_DESCRIPTOR_KIND, version: WATCH_DESCRIPTOR_VERSION, network: 'mainnet', classicalXpub: XPUB, falcon: { receive: [pq(1)], change: [] } },
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
