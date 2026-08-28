import { describe, expect, it } from 'vitest'
import { sighashCommitsTokenId } from '../../../src/main/brand/crypto'
import { PROFILE } from '../../../src/main/brand/profile'

// eCurrency schedules the token-id sign-data commitment by time (the
// node's SIGN_TOKEN_HASH_START): before it the chain rejects signatures
// that commit the token id, after it - signatures that omit it. The
// wallet switches by the same clock, not by a release.
describe('eCurrency token sighash fork', () => {
  it('pins the node fork times', () => {
    expect(PROFILE.tokenSighashFork).toEqual({
      mainnet: 1_789_430_400, // 2026-09-15
      testnet: 1_788_220_800, // 2026-09-01
    })
  })

  it('switches exactly at the fork moment', () => {
    expect(sighashCommitsTokenId('mainnet', 1_789_430_399)).toBe(false)
    expect(sighashCommitsTokenId('mainnet', 1_789_430_400)).toBe(true)
    expect(sighashCommitsTokenId('testnet', 1_788_220_799)).toBe(false)
    expect(sighashCommitsTokenId('testnet', 1_788_220_800)).toBe(true)
  })
})
