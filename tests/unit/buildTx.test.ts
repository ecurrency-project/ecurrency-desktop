import { describe, expect, it } from 'vitest'
import { DUST_ATOMIC, InsufficientFundsError, InsufficientTokensError, buildSend, buildTokenSend, estimateSendFee, feeForInputs, selectCoins, type SpendableTokenUtxo, type SpendableUtxo } from '../../src/main/wallet/buildTx'

// Real classical mainnet addresses (derived from the abandon…about vector), so
// decodeAddress accepts them and produces 20-byte scripthashes.
const RECIPIENT = 'ECQFhYJWVgDyNdsFWdpeG5w2G5it7Cwh4Gd'
const CHANGE = 'ECS6R4kofUWX9D9k8uansU69vwE2tvRhNkP'
// A real mainnet Falcon (PQ) address — decodeAddress yields a 32-byte scripthash.
const PQ_CHANGE = '26mTj5nPpxPYLHGEDFDcmu7W8FUUfWZ9CxjsyBMCq6rzJwz4wnkD'

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
    const fee = estimateSendFee({ utxos: pool, amountAtomic: 500n, feeRatePerVByte: RATE })
    // The whole pool is needed, and it goes out changeless: 500 + fee == 505.
    expect(fee).toBe(feeForInputs(pool, RATE, 1))
    expect(500n + fee).toBe(505n)
    // …which is strictly more than pricing a lone 500-input would have charged.
    expect(fee).toBeGreaterThan(feeForInputs([utxo('a', 0, 500n)], RATE, 2))
    // NOTE: this case used to assert an InsufficientFundsError — that was the
    // estimator refusing a send the pool covers exactly, i.e. the very bug the
    // "selection grows to cover its own fee" case below pins down.
    const built = buildSend({ utxos: pool, recipient: RECIPIENT, amountAtomic: 500n, feeAtomic: fee, changeAddress: CHANGE })
    expect(built.unsigned.inputs).toHaveLength(3)
    expect(built.changeAtomic).toBe(0n)
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
    expect(built.unsigned.inputs).toHaveLength(2) // one token UTXO + one ECR UTXO
    expect(built.unsigned.outputs).toHaveLength(3) // recipient token, token change, ECR change
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

  it('throws when there is no ECR to pay the fee', () => {
    expect(() => buildTokenSend({ ...base, nativeUtxos: [] })).toThrow(InsufficientFundsError)
  })
})

describe('estimateSendFee — selection grows to cover its own fee', () => {
  const RATE = 0.009765625

  it('funds an amount that a first-pass selection matches exactly (live pool)', () => {
    // The reported case: sending 1.69 out of 1.69899274. Largest-first against
    // the bare amount lands on 1.59 + 0.1 = exactly 1.69, which cannot also pay
    // the fee — but the pool holds another 0.00899274. The estimator used to
    // report insufficient funds here while "Max" (which spends everything)
    // worked, so the wallet refused a send it could clearly afford.
    const pool = [
      utxo('a', 0, 159_000_000n),
      utxo('b', 0, 10_000_000n),
      utxo('c', 0, 732_932n),
      utxo('d', 0, 131_974n),
      utxo('e', 0, 33_964n),
      utxo('f', 0, 404n),
    ]
    const amount = 169_000_000n
    const fee = estimateSendFee({ utxos: pool, amountAtomic: amount, feeRatePerVByte: RATE })
    expect(fee).toBeGreaterThan(0n)

    // …and the build that follows must succeed with the same fee.
    const built = buildSend({ utxos: pool, recipient: RECIPIENT, amountAtomic: amount, feeAtomic: fee, changeAddress: CHANGE })
    expect(built.amountAtomic).toBe(amount)
    expect(built.unsigned.inputs.length).toBeGreaterThanOrEqual(3) // 1.59 + 0.1 alone cannot pay the fee

    // Which coins the selector picks is its own business — branch-and-bound
    // happily takes 1.59 + 0.1 + 0.00000404 and folds the 399-atomic remainder
    // into the fee for a changeless send — so balance against the inputs it
    // actually chose, not against a guess at their order.
    const spent = built.unsigned.inputs.reduce((sum, i) => {
      const coin = pool.find((u) => u.txid === i.prevTxid && u.vout === i.vout)
      expect(coin).toBeDefined()
      return sum + (coin?.value ?? 0n)
    }, 0n)
    expect(spent).toBe(built.amountAtomic + built.feeAtomic + built.changeAtomic)
  })

  it('still reports insufficient funds when the pool truly cannot pay', () => {
    const pool = [utxo('a', 0, 1_000n), utxo('b', 0, 500n)]
    expect(() => estimateSendFee({ utxos: pool, amountAtomic: 1_500n, feeRatePerVByte: RATE })).toThrow(InsufficientFundsError)
  })

  it('a fixed manual set that cannot pay its fee is still a shortfall', () => {
    const coins = [utxo('a', 0, 169_000_000n)]
    expect(() =>
      estimateSendFee({ utxos: [], manualInputs: coins, amountAtomic: 169_000_000n, feeRatePerVByte: RATE }),
    ).toThrow(InsufficientFundsError)
  })
})

// ─── Invariants over generated pools ─────────────────────────────────
//
// The example-based tests above encode what the implementation does at
// specific points; they all passed while the wallet was refusing sends it
// could afford. These check what the PRODUCT must be true of, over a few
// hundred generated coin pools:
//
//   1. anything up to the send-max amount must build (the exact symptom that
//      was reported: "Max works, a smaller amount does not");
//   2. every successful build must balance: inputs = amount + fee + change.
//
// The generator is a seeded LCG, so a failure is reproducible from its seed
// and the suite stays deterministic (no new dependency).
describe('coin selection — invariants over generated pools', () => {
  const RATE = 0.009765625
  const ALGOS = ['ecdsa', 'schnorr', 'falcon512'] as const

  function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  // Pools mix magnitudes on purpose: the reported bug needed a couple of large
  // coins that sum exactly to the amount plus a tail of small ones.
  function makePool(rnd: () => number): SpendableUtxo[] {
    const count = 1 + Math.floor(rnd() * 8)
    const coins: SpendableUtxo[] = []
    for (let i = 0; i < count; i += 1) {
      const magnitude = [1n, 100n, 10_000n, 1_000_000n, 100_000_000n][Math.floor(rnd() * 5)] ?? 1n
      const value = BigInt(1 + Math.floor(rnd() * 999)) * magnitude
      // Mostly classical, occasionally PQ (a far larger, far more expensive input).
      const algo = ALGOS[rnd() < 0.85 ? 0 : 1 + Math.floor(rnd() * 2)] ?? 'ecdsa'
      coins.push({ txid: `t${String(i)}`, vout: i, value, chain: 0, index: i, algo })
    }
    return coins
  }

  it('any amount up to the send-max amount is spendable', () => {
    const rnd = lcg(20260725)
    for (let case_ = 0; case_ < 300; case_ += 1) {
      const pool = makePool(rnd)
      const total = pool.reduce((s, u) => s + u.value, 0n)
      // What "Max" would offer: the whole pool minus a one-output fee.
      const maxFee = estimateSendFee({ utxos: pool, amountAtomic: 0n, feeRatePerVByte: RATE, sendMax: true })
      if (total <= maxFee) continue // nothing sendable at all; not this invariant's business
      const maxAmount = total - maxFee

      // Sample the range: the max itself, just under it, a half, and the floor.
      for (const amount of [maxAmount, maxAmount - 1n, maxAmount / 2n, 1n]) {
        if (amount <= 0n) continue
        const fee = estimateSendFee({ utxos: pool, amountAtomic: amount, feeRatePerVByte: RATE })
        const built = buildSend({ utxos: pool, recipient: RECIPIENT, amountAtomic: amount, feeAtomic: fee, changeAddress: CHANGE, changeAddressFor: () => CHANGE })
        expect(built.amountAtomic).toBe(amount)
      }
    }
  })

  it('every build balances: inputs = amount + fee + change', () => {
    const rnd = lcg(770177)
    for (let case_ = 0; case_ < 300; case_ += 1) {
      const pool = makePool(rnd)
      const total = pool.reduce((s, u) => s + u.value, 0n)
      const maxFee = estimateSendFee({ utxos: pool, amountAtomic: 0n, feeRatePerVByte: RATE, sendMax: true })
      if (total <= maxFee) continue
      const amount = (total - maxFee) / 2n
      if (amount <= 0n) continue

      const fee = estimateSendFee({ utxos: pool, amountAtomic: amount, feeRatePerVByte: RATE })
      const built = buildSend({ utxos: pool, recipient: RECIPIENT, amountAtomic: amount, feeAtomic: fee, changeAddress: CHANGE, changeAddressFor: () => CHANGE })

      const spent = built.unsigned.inputs.reduce((sum, i) => {
        const coin = pool.find((u) => u.txid === i.prevTxid && u.vout === i.vout)
        expect(coin).toBeDefined()
        return sum + (coin?.value ?? 0n)
      }, 0n)
      // The fee absorbs a sub-dust remainder, so compare against the fee the
      // build reports, not the estimate it started from.
      expect(spent).toBe(built.amountAtomic + built.feeAtomic + built.changeAtomic)
      expect(built.changeAtomic === 0n || built.changeAtomic > DUST_ATOMIC).toBe(true)
    }
  })
})
