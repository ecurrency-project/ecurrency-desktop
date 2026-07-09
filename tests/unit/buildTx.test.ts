import { describe, expect, it } from 'vitest'
import { DUST_ATOMIC, InsufficientFundsError, InsufficientTokensError, buildSend, buildTokenSend, estimateSendFee, feeForInputs, selectCoins, type SpendableTokenUtxo, type SpendableUtxo } from '../../src/main/wallet/buildTx'

// Real classical mainnet addresses (derived from the abandon…about vector), so
// decodeAddress accepts them and produces 20-byte scripthashes.
const RECIPIENT = 'bqRS2bzC6BuG9Qm7hyMXJYzy295UEgZZCEX'
const CHANGE = 'bqTGk8SVFzBouz3cLF7fuwA6gzad2MzGhwf'
// A real mainnet Falcon (PQ) address — decodeAddress yields a 32-byte scripthash.
const PQ_CHANGE = '3uJPaK1HRrNyfpykzmCWHpKXWWFFS5uUKFFmk6YfrZhqv7driav9'

function utxo(txid: string, vout: number, value: bigint, index = 0): SpendableUtxo {
  return { txid, vout, value, chain: 0, index, algo: 'ecdsa' }
}

describe('buildSend', () => {
  it('routes change to the PQ branch when inputs are majority PQ', () => {
    const built = buildSend({
      utxos: [],
      manualInputs: [{ txid: 'pq', vout: 0, value: 5_000_000n, chain: 0, index: 0, algo: 'falcon512' }],
      recipient: RECIPIENT,
      amountAtomic: 1_000_000n,
      feeAtomic: 200n,
      changeAddressFor: (algo) => (algo === 'falcon512' ? PQ_CHANGE : CHANGE),
    })
    expect(built.changeAlgo).toBe('falcon512')
    expect(built.changeAtomic).toBe(5_000_000n - 1_000_000n - 200n)
  })

  it('folds dust-sized change into the fee (no tiny change output)', () => {
    // leftover 499 ≤ dust → folded: one output, fee absorbs it.
    const built = buildSend({ utxos: [utxo('aa', 0, 1_000_500n)], recipient: RECIPIENT, amountAtomic: 1_000_000n, feeAtomic: 1n, changeAddress: CHANGE })
    expect(built.unsigned.outputs).toHaveLength(1)
    expect(built.changeAtomic).toBe(0n)
    expect(built.feeAtomic).toBe(500n) // 1 + 499
    expect(built.totalAtomic).toBe(1_000_500n)
  })

  it('keeps change above the dust threshold as its own output', () => {
    const built = buildSend({ utxos: [utxo('aa', 0, 5_000_000n)], recipient: RECIPIENT, amountAtomic: 1_000_000n, feeAtomic: 200n, changeAddress: CHANGE })
    expect(built.unsigned.outputs).toHaveLength(2)
    expect(built.changeAtomic).toBe(3_999_800n)
    expect(built.feeAtomic).toBe(200n)
  })

  it('omits the change output on an exact spend', () => {
    const built = buildSend({ utxos: [utxo('aa', 0, 1_000_010n)], recipient: RECIPIENT, amountAtomic: 1_000_000n, feeAtomic: 10n, changeAddress: CHANGE })
    expect(built.unsigned.outputs).toHaveLength(1)
    expect(built.changeAtomic).toBe(0n)
  })

  it("carries each input's derivation scheme into the unsigned tx (signer needs it)", () => {
    const built = buildSend({
      utxos: [],
      manualInputs: [
        { ...utxo('aa', 0, 3_000_000n), scheme: 'fake-v1' },
        { ...utxo('bb', 0, 3_000_000n, 1) }, // no scheme (e.g. key wallet)
      ],
      recipient: RECIPIENT,
      amountAtomic: 5_000_000n,
      feeAtomic: 200n,
      changeAddress: CHANGE,
    })
    const byTxid = new Map(built.unsigned.inputs.map((i) => [i.prevTxid, i]))
    expect(byTxid.get('aa')!.scheme).toBe('fake-v1')
    expect(byTxid.get('bb')!.scheme).toBeUndefined()
  })

  it('sorts inputs into the canonical order (txid asc, then vout)', () => {
    const built = buildSend({
      utxos: [utxo('bb', 0, 1_000_000n, 5), utxo('aa', 1, 1_000_000n, 1), utxo('aa', 0, 1_000_000n, 0)],
      recipient: RECIPIENT,
      amountAtomic: 2_500_000n,
      feeAtomic: 200n,
      changeAddress: CHANGE,
    })
    expect(built.unsigned.inputs.map((i) => `${i.prevTxid}:${String(i.vout)}`)).toEqual(['aa:0', 'aa:1', 'bb:0'])
  })

  it('throws InsufficientFundsError when the pool cannot cover amount + fee', () => {
    expect(() => buildSend({ utxos: [utxo('aa', 0, 100n)], recipient: RECIPIENT, amountAtomic: 1_000n, feeAtomic: 1n, changeAddress: CHANGE })).toThrow(InsufficientFundsError)
  })

  it('spends exactly the manual inputs (coin control), ignoring the pool', () => {
    const built = buildSend({
      utxos: [utxo('zz', 0, 9_000_000n)],
      manualInputs: [utxo('aa', 0, 600_000n), utxo('bb', 0, 600_000n)],
      recipient: RECIPIENT,
      amountAtomic: 1_000_000n,
      feeAtomic: 200n,
      changeAddress: CHANGE,
    })
    expect(built.unsigned.inputs.map((i) => i.prevTxid).sort()).toEqual(['aa', 'bb'])
    expect(built.changeAtomic).toBe(199_800n)
  })

  it('throws when the manual inputs cannot cover amount + fee', () => {
    expect(() => buildSend({ utxos: [], manualInputs: [utxo('aa', 0, 500n)], recipient: RECIPIENT, amountAtomic: 1_000n, feeAtomic: 1n, changeAddress: CHANGE })).toThrow(InsufficientFundsError)
  })

  it('send-max spends the whole pool into one output with no change (amount = total − fee)', () => {
    const built = buildSend({
      utxos: [utxo('aa', 0, 1_000_000n), utxo('bb', 0, 2_000_000n)],
      recipient: RECIPIENT,
      amountAtomic: 0n, // ignored in send-max
      feeAtomic: 200n,
      sendMax: true,
      changeAddress: CHANGE,
    })
    expect(built.unsigned.inputs).toHaveLength(2)
    expect(built.unsigned.outputs).toHaveLength(1)
    expect(built.changeAtomic).toBe(0n)
    expect(built.amountAtomic).toBe(3_000_000n - 200n)
    expect(built.totalAtomic).toBe(3_000_000n)
  })

  it('send-max over manual inputs spends exactly those coins', () => {
    const built = buildSend({
      utxos: [utxo('zz', 0, 9_000_000n)],
      manualInputs: [utxo('aa', 0, 600_000n), utxo('bb', 0, 700_000n)],
      recipient: RECIPIENT,
      amountAtomic: 0n,
      feeAtomic: 200n,
      sendMax: true,
      changeAddress: CHANGE,
    })
    expect(built.unsigned.inputs.map((i) => i.prevTxid).sort()).toEqual(['aa', 'bb'])
    expect(built.amountAtomic).toBe(1_300_000n - 200n)
    expect(built.changeAtomic).toBe(0n)
  })

  it('send-max throws when the fee exceeds the pool total', () => {
    expect(() => buildSend({ utxos: [utxo('aa', 0, 100n)], recipient: RECIPIENT, amountAtomic: 0n, feeAtomic: 200n, sendMax: true, changeAddress: CHANGE })).toThrow(InsufficientFundsError)
  })
})

describe('estimateSendFee', () => {
  // Rate from the live node's /api/fee-estimates.
  const RATE = 0.009765625

  it('prices by the ACTUAL selected inputs, not a 1-input guess (auto)', () => {
    // Pool 500 + 3 + 2 (the on-chain regression). Sending 500 needs more than
    // one input, so the fee must reflect the multi-input tx — the old suggestFee
    // priced a single 500-input and under-charged.
    const pool = [utxo('a', 0, 500n), utxo('b', 0, 3n), utxo('c', 0, 2n)]
    // Fee for a single input would be ~3; for the set actually required it's higher.
    const oneInputFee = feeForInputs([utxo('a', 0, 500n)], RATE, 2)
    expect(() => estimateSendFee({ utxos: pool, amountAtomic: 500n, feeRatePerVByte: RATE })).toThrow(InsufficientFundsError)
    // …and the reason is that amount + real fee (needs all 3 inputs) exceeds the
    // 505 total — i.e. it is NOT under-charging to a coverable single-input fee.
    expect(500n + oneInputFee).toBeLessThanOrEqual(505n)
  })

  it('agrees between automatic and manual selection for the same coins', () => {
    // The core bug: auto said one thing, manual another. For the exact same input
    // set they must now produce the same fee.
    const coins = [utxo('a', 0, 5_000_000n), utxo('b', 0, 3_000_000n)]
    const auto = estimateSendFee({ utxos: coins, amountAtomic: 7_000_000n, feeRatePerVByte: RATE })
    const manual = estimateSendFee({ utxos: [], manualInputs: coins, amountAtomic: 7_000_000n, feeRatePerVByte: RATE })
    expect(auto).toBe(manual)
    expect(auto).toBe(feeForInputs(coins, RATE, 2)) // two inputs, with change
  })

  it('prices a changeless send with one output (cheaper than two)', () => {
    // A single input covering amount + 1-output fee exactly → changeless.
    const one = [utxo('a', 0, 1_000_000n)]
    const changelessFee = estimateSendFee({ utxos: [], manualInputs: one, amountAtomic: 1_000_000n - feeForInputs(one, RATE, 1), feeRatePerVByte: RATE })
    expect(changelessFee).toBe(feeForInputs(one, RATE, 1))
    expect(feeForInputs(one, RATE, 1)).toBeLessThan(feeForInputs(one, RATE, 2))
  })

  it('throws when a manual set cannot fund even a changeless send', () => {
    const one = [utxo('a', 0, 500n)]
    expect(() => estimateSendFee({ utxos: [], manualInputs: one, amountAtomic: 500n, feeRatePerVByte: RATE })).toThrow(InsufficientFundsError)
  })

  it('send-max prices a single output (no change)', () => {
    const pool = [utxo('a', 0, 1_000_000n), utxo('b', 0, 2_000_000n)]
    const fee = estimateSendFee({ utxos: pool, amountAtomic: 0n, feeRatePerVByte: RATE, sendMax: true })
    expect(fee).toBe(feeForInputs(pool, RATE, 1))
  })

  it('the estimated fee builds a valid draft (estimate == build)', () => {
    // Feed the estimate straight into buildSend and confirm it doesn't throw and
    // the reported fee matches — proving preview and build agree.
    const pool = [utxo('a', 0, 5_000_000n), utxo('b', 0, 3_000_000n)]
    const fee = estimateSendFee({ utxos: pool, amountAtomic: 7_000_000n, feeRatePerVByte: RATE })
    const built = buildSend({ utxos: pool, recipient: RECIPIENT, amountAtomic: 7_000_000n, feeAtomic: fee, changeAddress: CHANGE })
    expect(built.feeAtomic).toBe(fee)
    expect(BigInt(built.unsigned.outputs.reduce((s, o) => s + BigInt(o.valueAtomic), 0n)) + built.feeAtomic).toBe(8_000_000n)
  })
})

describe('selectCoins', () => {
  it('prefers a changeless subset within the dust margin', () => {
    // 300 + 500 = 800 = target exactly → changeless.
    const selected = selectCoins([utxo('a', 0, 300n), utxo('b', 0, 500n), utxo('c', 0, 700n)], 800n)
    expect(selected).not.toBeNull()
    expect(selected!.reduce((s, u) => s + u.value, 0n)).toBe(800n)
  })

  it('falls back to a covering set when no changeless subset exists', () => {
    const selected = selectCoins([utxo('a', 0, 5_000_000n)], 1_000_000n)
    expect(selected!.reduce((s, u) => s + u.value, 0n)).toBe(5_000_000n)
  })

  it('returns null when the pool is short', () => {
    expect(selectCoins([utxo('a', 0, 10n)], 50n)).toBeNull()
  })

  it('exposes the dust threshold', () => {
    expect(DUST_ATOMIC).toBe(1000n)
  })
})

describe('buildTokenSend', () => {
  const TOKEN = 'ab'.repeat(32)
  const tutxo = (txid: string, vout: number, tokenAmount: bigint): SpendableTokenUtxo => ({ txid, vout, value: 0n, chain: 0, index: 0, algo: 'ecdsa', tokenAmount })
  const base = {
    tokenHash: TOKEN,
    tokenUtxos: [tutxo('t1', 0, 100n)],
    nativeUtxos: [utxo('e1', 0, 1_000_000n)],
    recipient: RECIPIENT,
    tokenAmount: 30n,
    feeAtomic: 200n,
    tokenChangeAddressFor: () => CHANGE,
    nativeChangeAddressFor: () => CHANGE,
  }

  it('builds token in/out + token change + native fee change', () => {
    const built = buildTokenSend(base)
    expect(built.unsigned.tokenHash).toBe(TOKEN)
    expect(built.unsigned.inputs).toHaveLength(2) // one token UTXO + one native UTXO
    expect(built.unsigned.outputs).toHaveLength(3) // recipient token, token change, native change
    expect(built.unsigned.outputs[0]).toMatchObject({ valueAtomic: '0' })
    expect(built.unsigned.outputs[0]!.data).toBeDefined() // TRANSFER payload
    expect(built.tokenChangeAtomic).toBe(70n)
    expect(built.nativeChangeAtomic).toBe(1_000_000n - 200n)
  })

  it('omits token change on an exact token amount', () => {
    const built = buildTokenSend({ ...base, tokenUtxos: [tutxo('t1', 0, 30n)] })
    expect(built.tokenChangeAtomic).toBe(0n)
    expect(built.unsigned.outputs.filter((o) => o.data !== undefined)).toHaveLength(1) // only the recipient transfer
  })

  it('throws when token holdings cannot cover the amount', () => {
    expect(() => buildTokenSend({ ...base, tokenUtxos: [tutxo('t1', 0, 10n)] })).toThrow(InsufficientTokensError)
  })

  it('throws when there is nothing native to pay the fee', () => {
    expect(() => buildTokenSend({ ...base, nativeUtxos: [] })).toThrow(InsufficientFundsError)
  })
})
