import { describe, expect, it } from 'vitest'
import { fail } from '../../src/shared/protocol'
import { InsufficientFundsError } from '../../src/main/wallet/buildTx'
import { coinSelectionShort, isInsufficientFundsError } from '../../src/renderer/lib/sendValidation'

describe('isInsufficientFundsError', () => {
  it('matches the real InsufficientFundsError message', () => {
    // Binds the predicate to the actual error text — change the message in
    // buildTx and this test fails, forcing the detector to be updated too.
    const err = new InsufficientFundsError(1000n, 500n)
    expect(isInsufficientFundsError(err.message)).toBe(true)
  })

  it('still matches after the error crosses the IPC envelope (message survives)', () => {
    // The scenario that caused the bug: name detection failed across IPC, so we
    // switched to the message. Prove the message round-trips through fail().
    const res = fail(new InsufficientFundsError(1000n, 500n))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(isInsufficientFundsError(res.error.message)).toBe(true)
  })

  it('does not match unrelated failures', () => {
    expect(isInsufficientFundsError('Network request failed')).toBe(false)
    expect(isInsufficientFundsError('A token transfer needs a positive native fee.')).toBe(false)
    expect(isInsufficientFundsError('')).toBe(false)
  })
})

describe('coinSelectionShort', () => {
  const base = { selectedCount: 1, maxMode: false, picked: 0n, amount: 0n, fee: null as bigint | null, feeShort: false }

  it('is never short with no manual selection (automatic mode)', () => {
    expect(coinSelectionShort({ ...base, selectedCount: 0, picked: 0n, amount: 5n })).toBe(false)
  })

  it('is never short in send-max mode', () => {
    expect(coinSelectionShort({ ...base, maxMode: true, picked: 1n, amount: 5n })).toBe(false)
  })

  it('is short whenever the draft build reported insufficient funds', () => {
    expect(coinSelectionShort({ ...base, picked: 100n, amount: 5n, feeShort: true })).toBe(true)
  })

  // The regression: one coin exactly equal to the amount. The fee is unknown
  // (the build refused), so `<=` must flag it — `<` was the bug.
  it('is short when the selection exactly equals the amount and the fee is unknown', () => {
    expect(coinSelectionShort({ ...base, picked: 500n, amount: 500n, fee: null })).toBe(true)
  })

  it('is not short when the selection exceeds the amount and the fee is still unknown', () => {
    // Above the bare amount with an unknown fee — optimistic; feeShort covers the
    // fee-sized gap once the build resolves.
    expect(coinSelectionShort({ ...base, picked: 600n, amount: 500n, fee: null })).toBe(false)
  })

  it('uses amount + fee once the fee is known', () => {
    expect(coinSelectionShort({ ...base, picked: 520n, amount: 500n, fee: 30n })).toBe(true) // 520 < 530
    expect(coinSelectionShort({ ...base, picked: 530n, amount: 500n, fee: 30n })).toBe(false) // exactly covers
    expect(coinSelectionShort({ ...base, picked: 999n, amount: 500n, fee: 30n })).toBe(false)
  })

  it('is not short when the amount is not yet a valid number', () => {
    expect(coinSelectionShort({ ...base, picked: 0n, amount: null })).toBe(false)
  })
})
