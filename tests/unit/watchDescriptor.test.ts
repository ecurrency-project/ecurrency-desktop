import { addressFromScripthash, exportAccountXpub, masterKeyFromSeed, META_V1_SCHEME_ID } from '@qbitcoin/crypto'
import { describe, expect, it } from 'vitest'
import {
  buildWatchDescriptor,
  descriptorSchemes,
  encodeWatchDescriptor,
  isValidWatchDescriptor,
  parseWatchDescriptor,
  WATCH_DESCRIPTOR_KIND,
  type WatchDescriptorV1,
  type WatchDescriptorV2,
} from '../../src/main/wallet/watchDescriptor'

const master = masterKeyFromSeed(Uint8Array.from({ length: 64 }, (_, i) => (i * 5 + 1) & 0xff))
const XPUB = exportAccountXpub(master, 0)

// Format-valid addresses without Falcon WASM: a 32-byte scripthash encodes to a PQ
// address, a 20-byte one to a classical address.
const pqAddr = (fill: number): string => addressFromScripthash(new Uint8Array(32).fill(fill), 'mainnet')
const classicalAddr = (fill: number): string => addressFromScripthash(new Uint8Array(20).fill(fill), 'mainnet')

function validDescriptor(): WatchDescriptorV2 {
  return {
    kind: WATCH_DESCRIPTOR_KIND,
    version: 2,
    network: 'mainnet',
    schemes: [
      { scheme: 'fake-v2', classicalXpub: XPUB, falcon: { receive: [pqAddr(1), pqAddr(2)], change: [pqAddr(3)] } },
      { scheme: 'fake-v1', classicalXpub: XPUB, falcon: { receive: [pqAddr(4)], change: [] } },
    ],
  }
}

function validV1Descriptor(): WatchDescriptorV1 {
  return {
    kind: WATCH_DESCRIPTOR_KIND,
    version: 1,
    network: 'mainnet',
    classicalXpub: XPUB,
    falcon: { receive: [pqAddr(1), pqAddr(2)], change: [pqAddr(3)] },
  }
}

describe('buildWatchDescriptor', () => {
  it('emits a v2 descriptor with one section per scheme, deriving each Falcon list over 0..(issued+lookahead)', async () => {
    const calls: string[] = []
    const deriveFalcon = (tag: string) => (chain: 0 | 1, index: number): Promise<string> => {
      calls.push(`${tag}:${chain}:${index}`)
      return Promise.resolve(pqAddr((chain + 1) * 10 + index))
    }
    const d = await buildWatchDescriptor({
      network: 'mainnet',
      label: '  Cold vault  ',
      schemes: [
        { scheme: 'fake-v2', classicalXpub: XPUB, deriveFalcon: deriveFalcon('v2'), pqFloors: { receive: 1, change: 0 } },
        { scheme: 'fake-v1', classicalXpub: XPUB, deriveFalcon: deriveFalcon('v1'), pqFloors: { receive: 0, change: 0 } },
      ],
      lookahead: { receive: 2, change: 1 },
    })
    expect(d.version).toBe(2)
    expect(d.label).toBe('Cold vault') // trimmed
    expect(d.schemes.map((s) => s.scheme)).toEqual(['fake-v2', 'fake-v1'])
    expect(d.schemes[0]!.classicalXpub).toBe(XPUB)
    expect(d.schemes[0]!.falcon.receive).toHaveLength(4) // indices 0..(1+2)
    expect(d.schemes[0]!.falcon.change).toHaveLength(2) // indices 0..(0+1)
    expect(d.schemes[1]!.falcon.receive).toHaveLength(3) // indices 0..(0+2)
    expect(calls).toContain('v2:0:3')
    expect(calls).toContain('v2:1:1')
    expect(calls).toContain('v1:0:2')
  })

  it('omits a blank label and refuses an empty scheme list', async () => {
    const d = await buildWatchDescriptor({
      network: 'mainnet',
      label: '   ',
      schemes: [
        {
          scheme: 'fake-v2',
          classicalXpub: XPUB,
          deriveFalcon: (_chain: 0 | 1, index: number) => Promise.resolve(pqAddr(index)),
          pqFloors: { receive: 0, change: 0 },
        },
      ],
      lookahead: { receive: 0, change: 0 },
    })
    expect('label' in d).toBe(false)
    await expect(buildWatchDescriptor({ network: 'mainnet', schemes: [] })).rejects.toThrow(/at least one scheme/)
  })
})

describe('parse / encode', () => {
  it('round-trips a valid v2 descriptor', () => {
    const d = validDescriptor()
    expect(parseWatchDescriptor(encodeWatchDescriptor(d))).toEqual(d)
  })

  it('round-trips a v1 descriptor unchanged (accepted forever)', () => {
    const d = validV1Descriptor()
    expect(parseWatchDescriptor(encodeWatchDescriptor(d))).toEqual(d)
  })

  it('accepts valid input and rejects junk', () => {
    expect(isValidWatchDescriptor(encodeWatchDescriptor(validDescriptor()))).toBe(true)
    expect(isValidWatchDescriptor('{not json')).toBe(false)
    expect(isValidWatchDescriptor('"a string"')).toBe(false)
  })
})

describe('descriptorSchemes', () => {
  it('returns v2 sections as-is', () => {
    expect(descriptorSchemes(validDescriptor())).toEqual(validDescriptor().schemes)
  })

  it('normalizes a v1 descriptor to a single section owned by the pre-multi-scheme scheme', () => {
    const v1 = validV1Descriptor()
    expect(descriptorSchemes(v1)).toEqual([{ scheme: META_V1_SCHEME_ID, classicalXpub: v1.classicalXpub, falcon: v1.falcon }])
  })
})

describe('validation', () => {
  const mutate = (patch: Record<string, unknown>): string => JSON.stringify({ ...validDescriptor(), ...patch })
  const mutateSection = (patch: Record<string, unknown>): string => {
    const d = validDescriptor()
    return JSON.stringify({ ...d, schemes: [{ ...d.schemes[0]!, ...patch }, d.schemes[1]!] })
  }
  const mutateV1 = (patch: Record<string, unknown>): string => JSON.stringify({ ...validV1Descriptor(), ...patch })

  it('rejects a wrong kind or version', () => {
    expect(isValidWatchDescriptor(mutate({ kind: 'nope' }))).toBe(false)
    expect(isValidWatchDescriptor(mutate({ version: 999 }))).toBe(false)
  })

  it('rejects an unknown network', () => {
    expect(isValidWatchDescriptor(mutate({ network: 'regtest' }))).toBe(false)
  })

  it('rejects an empty or duplicate scheme list', () => {
    expect(isValidWatchDescriptor(mutate({ schemes: [] }))).toBe(false)
    const d = validDescriptor()
    expect(isValidWatchDescriptor(JSON.stringify({ ...d, schemes: [d.schemes[0]!, d.schemes[0]!] }))).toBe(false)
  })

  it('rejects a section without a scheme id', () => {
    expect(isValidWatchDescriptor(mutateSection({ scheme: '' }))).toBe(false)
    expect(isValidWatchDescriptor(mutateSection({ scheme: undefined }))).toBe(false)
  })

  it('accepts a scheme id this build does not know (forward compatibility)', () => {
    expect(isValidWatchDescriptor(mutateSection({ scheme: 'from-a-newer-wallet' }))).toBe(true)
  })

  it('rejects an invalid account xpub (both versions)', () => {
    expect(isValidWatchDescriptor(mutateSection({ classicalXpub: 'xpub-garbage' }))).toBe(false)
    expect(isValidWatchDescriptor(mutateV1({ classicalXpub: 'xpub-garbage' }))).toBe(false)
  })

  it('rejects a classical address in the Falcon list (both versions)', () => {
    expect(isValidWatchDescriptor(mutateSection({ falcon: { receive: [classicalAddr(9)], change: [] } }))).toBe(false)
    expect(isValidWatchDescriptor(mutateV1({ falcon: { receive: [classicalAddr(9)], change: [] } }))).toBe(false)
  })

  it('rejects a Falcon address from another network', () => {
    const testnetPq = addressFromScripthash(new Uint8Array(32).fill(4), 'testnet')
    expect(isValidWatchDescriptor(mutateSection({ falcon: { receive: [testnetPq], change: [] } }))).toBe(false)
  })

  it('rejects a missing Falcon section (both versions)', () => {
    expect(isValidWatchDescriptor(mutateSection({ falcon: undefined }))).toBe(false)
    const raw = JSON.parse(encodeWatchDescriptor(validV1Descriptor())) as Record<string, unknown>
    delete raw.falcon
    expect(isValidWatchDescriptor(JSON.stringify(raw))).toBe(false)
  })
})
