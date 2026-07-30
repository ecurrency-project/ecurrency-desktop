import { describe, expect, it } from 'vitest'
import { brand } from '../../src/renderer/brand'
import { addressPlaceholderFor, assetLabelFor } from '../../src/renderer/brand/labels'

// The per-network brand strings. A brand branch overrides the VALUES; what is
// pinned here is the shape and the reading rule, which every brand shares.
describe('per-network brand labels', () => {
  it('reads the label of the requested network', () => {
    expect(assetLabelFor('mainnet')).toBe(brand.assetLabel.mainnet)
    expect(assetLabelFor('testnet')).toBe(brand.assetLabel.testnet)
    expect(addressPlaceholderFor('mainnet')).toBe(brand.addressPlaceholder.mainnet)
    expect(addressPlaceholderFor('testnet')).toBe(brand.addressPlaceholder.testnet)
  })

  it('falls back to mainnet while the build network is unknown', () => {
    expect(assetLabelFor(null)).toBe(brand.assetLabel.mainnet)
    expect(addressPlaceholderFor(null)).toBe(brand.addressPlaceholder.mainnet)
  })

  it('never labels testnet coins with the mainnet ticker', () => {
    // The whole point of the per-network ticker: test coins must be
    // distinguishable at a glance from the real ones.
    expect(brand.assetLabel.testnet).not.toBe(brand.assetLabel.mainnet)
    for (const label of Object.values(brand.assetLabel)) expect(label.trim()).not.toBe('')
  })
})
