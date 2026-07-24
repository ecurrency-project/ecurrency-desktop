import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  dataRootFor,
  parseNetworkProfile,
  readNetworkProfile,
  writeNetworkProfile,
} from '../../src/main/vault/networkProfile'

// The profile decides which network the process runs on AND where its data
// lives. The invariants under test are safety properties:
//  - anything but an explicit, well-formed testnet profile means mainnet
//    (a broken file must never strand users away from their mainnet wallets);
//  - the mainnet data root is the base directory ITSELF — byte-exact
//    historical paths (the userData trap).

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'netprofile-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('parseNetworkProfile', () => {
  it('defaults to mainnet for missing/malformed/unknown content', () => {
    expect(parseNetworkProfile(null)).toBe('mainnet')
    expect(parseNetworkProfile('')).toBe('mainnet')
    expect(parseNetworkProfile('not json')).toBe('mainnet')
    expect(parseNetworkProfile('{}')).toBe('mainnet')
    expect(parseNetworkProfile('{"network":"regtest"}')).toBe('mainnet')
    expect(parseNetworkProfile('{"network":42}')).toBe('mainnet')
  })

  it('accepts an explicit testnet', () => {
    expect(parseNetworkProfile('{"network":"testnet"}')).toBe('testnet')
  })
})

describe('read/write roundtrip', () => {
  it('reads mainnet when no profile exists', () => {
    expect(readNetworkProfile(tmp())).toBe('mainnet')
  })

  it('roundtrips both networks', () => {
    const dir = tmp()
    writeNetworkProfile(dir, 'testnet')
    expect(readNetworkProfile(dir)).toBe('testnet')
    writeNetworkProfile(dir, 'mainnet')
    expect(readNetworkProfile(dir)).toBe('mainnet')
  })
})

describe('dataRootFor', () => {
  it('mainnet is the base directory itself — historical paths unchanged', () => {
    const dir = tmp()
    expect(dataRootFor(dir, 'mainnet')).toBe(dir)
    // …and nothing was created inside.
    expect(existsSync(join(dir, 'mainnet'))).toBe(false)
  })

  it('testnet is an isolated subtree, created on demand', () => {
    const dir = tmp()
    const root = dataRootFor(dir, 'testnet')
    expect(root).toBe(join(dir, 'testnet'))
    expect(existsSync(root)).toBe(true)
  })
})
