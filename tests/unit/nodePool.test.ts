import { describe, expect, it } from 'vitest'
import type { NodeEndpoint } from '@qbtc/chain'
import type { NodeSettingsStored } from '../../src/main/vault/nodeConfig'
import { buildEndpoints, primaryPublicUrl } from '../../src/main/vault/nodePool'

// Two bundled endpoints, as a brand that ships more than one would.
const BUNDLED_A: NodeEndpoint = { name: 'a.example', url: 'https://a.example', protocol: 'esplora', network: 'mainnet', operator: 'Project', priority: 1 }
const BUNDLED_B: NodeEndpoint = { name: 'b.example', url: 'https://b.example', protocol: 'esplora', network: 'mainnet', operator: 'Project', priority: 2 }
const BUNDLED = [BUNDLED_A, BUNDLED_B]

function settings(patch: Partial<NodeSettingsStored> = {}): NodeSettingsStored {
  return { selected: 'public', tor: false, customNodes: [], ...patch }
}

const urls = (list: readonly NodeEndpoint[]): string[] => list.map((e) => e.url)

describe('primaryPublicUrl', () => {
  it('honours the stored pick', () => {
    expect(primaryPublicUrl({ selectedPublicUrl: BUNDLED_B.url }, BUNDLED)).toBe(BUNDLED_B.url)
  })

  it('falls back to the first bundled node when nothing is picked', () => {
    // Configs written before the pick existed land here.
    expect(primaryPublicUrl({}, BUNDLED)).toBe(BUNDLED_A.url)
  })

  it('falls back to the first when the pick is no longer bundled', () => {
    expect(primaryPublicUrl({ selectedPublicUrl: 'https://gone.example' }, BUNDLED)).toBe(BUNDLED_A.url)
  })

  it('is undefined when the build bundles none', () => {
    expect(primaryPublicUrl({ selectedPublicUrl: BUNDLED_A.url }, [])).toBeUndefined()
  })
})

describe('buildEndpoints', () => {
  it('sends the own node alone — no fallback to anyone else', () => {
    // It may carry credentials and is chosen for privacy; falling back to a
    // public backend would leak the very queries self-hosting protects.
    const pool = buildEndpoints(
      settings({ selected: 'own', ownUrl: 'https://mine.example', customNodes: [{ url: 'https://c.example' }] }),
      BUNDLED,
      'mainnet',
    )
    expect(urls(pool)).toEqual(['https://mine.example'])
    expect(pool[0]?.operator).toBe('Self-hosted')
  })

  it('leads with the picked bundled node and keeps the rest as fallback', () => {
    const pool = buildEndpoints(settings({ selectedPublicUrl: BUNDLED_B.url }), BUNDLED, 'mainnet')
    expect(urls(pool)).toEqual([BUNDLED_B.url, BUNDLED_A.url])
    expect(pool[0]?.priority).toBe(1)
  })

  it('leads with the first bundled node when nothing is picked', () => {
    expect(urls(buildEndpoints(settings(), BUNDLED, 'mainnet'))).toEqual([BUNDLED_A.url, BUNDLED_B.url])
  })

  it('mixes user-added nodes in behind the bundled ones', () => {
    const pool = buildEndpoints(settings({ customNodes: [{ url: 'https://c.example', name: 'Mine' }] }), BUNDLED, 'mainnet')
    expect(urls(pool)).toEqual([BUNDLED_A.url, BUNDLED_B.url, 'https://c.example'])
    expect(pool[2]?.operator).toBe('User-added')
    expect(pool[2]?.name).toBe('Mine')
  })

  it('lifts a selected user-added node above the bundled ones', () => {
    const pool = buildEndpoints(
      settings({ selected: 'custom', selectedCustomUrl: 'https://c.example', customNodes: [{ url: 'https://c.example' }] }),
      BUNDLED,
      'mainnet',
    )
    expect(urls(pool)).toEqual(['https://c.example', BUNDLED_A.url, BUNDLED_B.url])
    expect(pool[0]?.priority).toBe(1)
    // Unnamed nodes are shown by host.
    expect(pool[0]?.name).toBe('c.example')
  })

  it('serves a brand with no bundled nodes from the added ones', () => {
    const pool = buildEndpoints(settings({ customNodes: [{ url: 'https://c.example' }] }), [], 'testnet')
    expect(urls(pool)).toEqual(['https://c.example'])
    expect(pool[0]?.network).toBe('testnet')
  })

  it('is empty when there is nothing to talk to', () => {
    // A legitimate boot state: the app starts so the user can add a node.
    expect(buildEndpoints(settings(), [], 'testnet')).toEqual([])
  })
})
