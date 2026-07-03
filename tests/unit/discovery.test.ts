import type { AddressInfo } from '@qbitcoin/chain'
import { describe, expect, it } from 'vitest'
import { GAP_LIMIT_CHANGE, GAP_LIMIT_RECEIVE, discoverAll, discoverBranch, discoverChain, type AddressLookup, type DiscoveryBranch } from '../../src/main/wallet/discovery'

const ZERO = { fundedTxCount: 0, fundedSum: 0n, spentTxCount: 0, spentSum: 0n }
const empty = (address: string): AddressInfo => ({ address, chain: ZERO, mempool: ZERO, tokens: {} })
const lookup = { getAddressInfo: async (address: string) => empty(address) }
const derive = (chain: 0 | 1, index: number): string => `addr-${chain}-${index}`

describe('discovery gap limits', () => {
  it('uses 20 for receive and 6 for change', () => {
    expect(GAP_LIMIT_RECEIVE).toBe(20)
    expect(GAP_LIMIT_CHANGE).toBe(6)
  })

  it('scans the receive chain up to its gap limit when all are empty', async () => {
    const found = await discoverChain(derive, lookup, 0, 0, GAP_LIMIT_RECEIVE)
    expect(found).toHaveLength(20)
  })

  it('scans the change chain up to its smaller gap limit when all are empty', async () => {
    const found = await discoverChain(derive, lookup, 1, 0, GAP_LIMIT_CHANGE)
    expect(found).toHaveLength(6)
  })

  it('scans at least to the floor (issued-but-unused) plus the gap', async () => {
    const found = await discoverChain(derive, lookup, 1, 10, GAP_LIMIT_CHANGE)
    expect(found).toHaveLength(16) // indices 0..15
  })

  it('discoverAll applies 20 to receive and 6 to change', async () => {
    const all = await discoverAll(derive, lookup, { receive: 0, change: 0 })
    expect(all.filter((a) => a.chain === 0)).toHaveLength(20)
    expect(all.filter((a) => a.chain === 1)).toHaveLength(6)
  })
})

describe('discoverBranch', () => {
  const funded = (address: string): AddressInfo => ({
    address,
    chain: { fundedTxCount: 1, fundedSum: 100n, spentTxCount: 0, spentSum: 0n },
    mempool: ZERO,
    tokens: {},
  })
  const counting = (active: ReadonlySet<string>): { lookup: AddressLookup; calls: () => number } => {
    let n = 0
    return {
      lookup: { getAddressInfo: (address: string) => { n += 1; return Promise.resolve(active.has(address) ? funded(address) : empty(address)) } },
      calls: () => n,
    }
  }

  it('checks exactly the addresses of a fixed list branch (no gap scan)', async () => {
    const branch: DiscoveryBranch = {
      kind: 'list',
      algo: 'falcon512',
      addresses: [
        { chain: 0, index: 0, address: 'pq-a' },
        { chain: 0, index: 1, address: 'pq-b' },
        { chain: 1, index: 0, address: 'pq-c' },
      ],
    }
    const { lookup: lk, calls } = counting(new Set(['pq-a']))
    const found = await discoverBranch(branch, lk)
    expect(calls()).toBe(3) // only the listed addresses — nothing scanned beyond them
    expect(found.map((f) => f.address)).toEqual(['pq-a', 'pq-b', 'pq-c'])
  })

  it('gap-scans a derivable branch from the floor', async () => {
    const branch: DiscoveryBranch = { kind: 'derive', algo: 'ecdsa', derive, floors: { receive: 0, change: 0 } }
    const { lookup: lk, calls } = counting(new Set())
    const found = await discoverBranch(branch, lk)
    expect(calls()).toBe(26) // receive gap (20) + change gap (6) on an empty wallet
    expect(found.every((f) => f.address.startsWith('addr-'))).toBe(true)
  })
})
