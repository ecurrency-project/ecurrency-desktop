import { masterKeyFromSeed, mnemonicToSeed } from '@qbtc/crypto'
import { decodeAddress, validateAddress } from '../../src/main/brand/crypto'
import { describe, expect, it } from 'vitest'
import { deriveClassicalAddress } from '../../src/main/wallet/addresses'

// Standard BIP-39 test vector. We don't hardcode the expected address (that
// would just restate the implementation); instead we assert the invariants a
// correct derivation must satisfy: validity, network prefix, classical type,
// determinism, and that chain/index actually change the result.
const MASTER = masterKeyFromSeed(mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))

describe('deriveClassicalAddress', () => {
  it('derives a valid mainnet classical address (bq… prefix, HASH160 type)', () => {
    const addr = deriveClassicalAddress(MASTER, { chain: 0, index: 0, network: 'mainnet' })
    expect(validateAddress(addr, 'mainnet')).toBe(true)
    expect(addr.startsWith('bq')).toBe(true)
    expect(decodeAddress(addr).type).toBe('classical')
  })

  it('is deterministic for the same path', () => {
    const a = deriveClassicalAddress(MASTER, { chain: 0, index: 0, network: 'mainnet' })
    const b = deriveClassicalAddress(MASTER, { chain: 0, index: 0, network: 'mainnet' })
    expect(a).toBe(b)
  })

  it('gives a distinct address per index and per chain', () => {
    const receive0 = deriveClassicalAddress(MASTER, { chain: 0, index: 0, network: 'mainnet' })
    const receive1 = deriveClassicalAddress(MASTER, { chain: 0, index: 1, network: 'mainnet' })
    const change0 = deriveClassicalAddress(MASTER, { chain: 1, index: 0, network: 'mainnet' })
    expect(new Set([receive0, receive1, change0]).size).toBe(3)
  })

  it('derives a valid testnet address (btq… prefix)', () => {
    const addr = deriveClassicalAddress(MASTER, { chain: 0, index: 0, network: 'testnet' })
    expect(validateAddress(addr, 'testnet')).toBe(true)
    expect(addr.startsWith('btq')).toBe(true)
  })
})
