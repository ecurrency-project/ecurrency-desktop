import { describe, expect, it } from 'vitest'
import { formatNative, formatToken, historyAmount, parseNative, parseToken, tokenLabels, transactionFeeDisplay } from '../../src/renderer/lib/format'

describe('formatToken', () => {
  it('formats at the given precision, trimming trailing zeros', () => {
    expect(formatToken('100000000', 8)).toBe('1')
    expect(formatToken('150000000', 8)).toBe('1.5')
    expect(formatToken('1', 8)).toBe('0.00000001')
    expect(formatToken('1000000', 6)).toBe('1') // a 6-decimal token (USDT-style)
    expect(formatToken('1234560', 6)).toBe('1.23456')
    expect(formatToken('5', 0)).toBe('5') // 0-decimal token
  })

  it('returns 0 for non-numeric input', () => {
    expect(formatToken('abc', 6)).toBe('0')
  })

  it('formatNative is the 8-decimal case', () => {
    expect(formatNative('123450000')).toBe('1.2345')
    expect(formatNative('0')).toBe('0')
  })
})

describe('transactionFeeDisplay', () => {
  it('shows a negative stake fee as a positive reward without changing the source', () => {
    const tx = { txType: 2, feeAtomic: '-126' }
    const fee = transactionFeeDisplay(tx)
    expect(fee).toEqual({ label: 'Staking reward', amountAtomic: '126' })
    expect(formatNative(fee.amountAtomic)).toBe('0.00000126')
    expect(tx.feeAtomic).toBe('-126')
  })

  it('keeps a large reward exact', () => {
    expect(transactionFeeDisplay({ txType: 2, feeAtomic: '-9007199254740993' })).toEqual({
      label: 'Staking reward', amountAtomic: '9007199254740993',
    })
  })

  it.each([
    [2, '0', 'Fee'],
    [2, '126', 'Fee'],
    [1, '126', 'Fee'],
    [3, '126', 'Fee'],
    [5, '126', 'Penalty'],
    [6, '126', 'Burned'],
    [undefined, '126', 'Fee'],
    [0, '-126', 'Fee'],
  ])('labels type %s with amount %s as %s', (txType, feeAtomic, label) => {
    expect(transactionFeeDisplay({ txType, feeAtomic })).toEqual({ label, amountAtomic: feeAtomic })
  })
})

describe('parseToken', () => {
  it('parses decimals into atomic units at the given precision', () => {
    expect(parseToken('1', 6)).toBe(1_000_000n)
    expect(parseToken('1.23456', 6)).toBe(1_234_560n)
    expect(parseToken('1', 8)).toBe(100_000_000n)
    expect(parseToken('5', 0)).toBe(5n)
  })

  it('rejects more fraction digits than the precision allows', () => {
    expect(() => parseToken('1.1234567', 6)).toThrow() // 7 > 6
    expect(() => parseToken('1.5', 0)).toThrow() // fraction on a 0-decimal token
  })

  it('parseNative is the 8-decimal case', () => {
    expect(parseNative('1.2345')).toBe(123_450_000n)
    expect(() => parseNative('1.123456789')).toThrow() // 9 > 8
  })
})

describe('tokenLabels', () => {
  it('treats the shorter label as the ticker (the node stores "USDT" in name)', () => {
    expect(tokenLabels({ symbol: 'Tether USD', name: 'USDT' })).toEqual({ ticker: 'USDT', name: 'Tether USD' })
  })

  it('also works when the fields follow the usual convention', () => {
    expect(tokenLabels({ symbol: 'AAA', name: 'Token A' })).toEqual({ ticker: 'AAA', name: 'Token A' })
  })

  it('falls back to the single present label for both', () => {
    expect(tokenLabels({ name: 'USDT' })).toEqual({ ticker: 'USDT', name: 'USDT' })
    expect(tokenLabels({ symbol: 'AAA' })).toEqual({ ticker: 'AAA', name: 'AAA' })
  })

  it('ignores blank labels and defaults to "Token" when nothing is usable', () => {
    expect(tokenLabels({ symbol: '   ', name: 'USDT' })).toEqual({ ticker: 'USDT', name: 'USDT' })
    expect(tokenLabels({})).toEqual({ ticker: 'Token', name: 'Token' })
    expect(tokenLabels({ symbol: '', name: '' })).toEqual({ ticker: 'Token', name: 'Token' })
  })

  it('on equal-length labels keeps symbol as the ticker', () => {
    expect(tokenLabels({ symbol: 'ABC', name: 'XYZ' })).toEqual({ ticker: 'ABC', name: 'XYZ' })
  })
})

describe('historyAmount', () => {
  it('labels a native-coin row with the ticker it is given', () => {
    // The caller passes the per-network ticker (useAssetLabel); the formatter
    // itself is brand-free, so testnet rows carry the testnet ticker.
    expect(historyAmount({ amountAtomic: '123450000' }, 'COIN')).toBe('1.2345 COIN')
    expect(historyAmount({ amountAtomic: '123450000' }, 'tCOIN')).toBe('1.2345 tCOIN')
  })

  it('formats a token row from its movement, not the native side', () => {
    expect(historyAmount({ tokenId: 'x', tokenAmountAtomic: '15000000', tokenDecimals: 6, tokenTicker: 'USDT', amountAtomic: '0' }, 'COIN')).toBe('15 USDT')
  })

  it('falls back to 0 / 6 decimals / "Token" when token fields are missing', () => {
    expect(historyAmount({ tokenId: 'x', amountAtomic: '0' }, 'COIN')).toBe('0 Token')
  })
})
