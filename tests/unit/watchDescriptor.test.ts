import { addressFromScripthash, exportAccountXpub, masterKeyFromSeed } from '@qbitcoin/crypto'
import { describe, expect, it } from 'vitest'
import {
  buildWatchDescriptor,
  encodeWatchDescriptor,
  isValidWatchDescriptor,
  parseWatchDescriptor,
  WATCH_DESCRIPTOR_KIND,
  WATCH_DESCRIPTOR_VERSION,
  type WatchDescriptor,
} from '../../src/main/wallet/watchDescriptor'

const master = masterKeyFromSeed(Uint8Array.from({ length: 64 }, (_, i) => (i * 5 + 1) & 0xff))
const XPUB = exportAccountXpub(master, 0)

// Format-valid addresses without Falcon WASM: a 32-byte scripthash encodes to a PQ
// address, a 20-byte one to a classical address.
const pqAddr = (fill: number): string => addressFromScripthash(new Uint8Array(32).fill(fill), 'mainnet')
const classicalAddr = (fill: number): string => addressFromScripthash(new Uint8Array(20).fill(fill), 'mainnet')

function validDescriptor(): WatchDescriptor {
  return {
    kind: WATCH_DESCRIPTOR_KIND,
    version: WATCH_DESCRIPTOR_VERSION,
    network: 'mainnet',
    classicalXpub: XPUB,
    falcon: { receive: [pqAddr(1), pqAddr(2)], change: [pqAddr(3)] },
  }
}

describe('buildWatchDescriptor', () => {
  it('carries the xpub and derives the Falcon list over 0..(issued+lookahead)', async () => {
    const calls: string[] = []
    const deriveFalcon = (chain: 0 | 1, index: number): Promise<string> => {
      calls.push(`${chain}:${index}`)
      return Promise.resolve(pqAddr((chain + 1) * 10 + index))
    }
    const d = await buildWatchDescriptor({
      network: 'mainnet',
      label: '  Cold vault  ',
      classicalXpub: XPUB,
      deriveFalcon,
      pqFloors: { receive: 1, change: 0 },
      lookahead: { receive: 2, change: 1 },
    })
    expect(d.classicalXpub).toBe(XPUB)
    expect(d.label).toBe('Cold vault') // trimmed
    expect(d.falcon.receive).toHaveLength(4) // indices 0..(1+2)
    expect(d.falcon.change).toHaveLength(2) // indices 0..(0+1)
    expect(calls).toContain('0:3')
    expect(calls).toContain('1:1')
  })

  it('omits a blank label', async () => {
    const d = await buildWatchDescriptor({
      network: 'mainnet',
      label: '   ',
      classicalXpub: XPUB,
      deriveFalcon: (_chain, index) => Promise.resolve(pqAddr(index)),
      pqFloors: { receive: 0, change: 0 },
      lookahead: { receive: 0, change: 0 },
    })
    expect('label' in d).toBe(false)
  })
})

describe('parse / encode', () => {
  it('round-trips a valid descriptor', () => {
    const d = validDescriptor()
    expect(parseWatchDescriptor(encodeWatchDescriptor(d))).toEqual(d)
  })

  it('accepts valid input and rejects junk', () => {
    expect(isValidWatchDescriptor(encodeWatchDescriptor(validDescriptor()))).toBe(true)
    expect(isValidWatchDescriptor('{not json')).toBe(false)
    expect(isValidWatchDescriptor('"a string"')).toBe(false)
  })
})

describe('validation', () => {
  const mutate = (patch: Record<string, unknown>): string => JSON.stringify({ ...validDescriptor(), ...patch })

  it('rejects a wrong kind or version', () => {
    expect(isValidWatchDescriptor(mutate({ kind: 'nope' }))).toBe(false)
    expect(isValidWatchDescriptor(mutate({ version: 999 }))).toBe(false)
  })

  it('rejects an unknown network', () => {
    expect(isValidWatchDescriptor(mutate({ network: 'regtest' }))).toBe(false)
  })

  it('rejects an invalid account xpub', () => {
    expect(isValidWatchDescriptor(mutate({ classicalXpub: 'xpub-garbage' }))).toBe(false)
  })

  it('rejects a classical address in the Falcon list', () => {
    const bad = JSON.stringify({ ...validDescriptor(), falcon: { receive: [classicalAddr(9)], change: [] } })
    expect(isValidWatchDescriptor(bad)).toBe(false)
  })

  it('rejects a Falcon address from another network', () => {
    const testnetPq = addressFromScripthash(new Uint8Array(32).fill(4), 'testnet')
    const bad = JSON.stringify({ ...validDescriptor(), falcon: { receive: [testnetPq], change: [] } })
    expect(isValidWatchDescriptor(bad)).toBe(false)
  })

  it('rejects a missing Falcon section', () => {
    const raw = JSON.parse(encodeWatchDescriptor(validDescriptor())) as Record<string, unknown>
    delete raw.falcon
    expect(isValidWatchDescriptor(JSON.stringify(raw))).toBe(false)
  })
})
