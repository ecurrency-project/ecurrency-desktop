import { describe, expect, it } from 'vitest'
import { SendService, type SendDeps } from '../../src/main/wallet/SendService'
import type { GatheredUtxo } from '../../src/main/wallet/spendable'

const RECIPIENT = 'ECQFhYJWVgDyNdsFWdpeG5w2G5it7Cwh4Gd'
const CHANGE = 'ECS6R4kofUWX9D9k8uansU69vwE2tvRhNkP'

function harness(utxos: GatheredUtxo[], frozen: ReadonlySet<string> = new Set()) {
  const calls = { sign: 0, broadcast: [] as string[], advance: 0 }
  const deps: SendDeps = {
    gather: async () => utxos,
    feeRate: async () => 1,
    frozen: async () => frozen,
    getChangeAddress: async () => CHANGE,
    getPqChangeAddress: async () => CHANGE,
    advanceChange: async () => {
      calls.advance++
    },
    sign: async () => {
      calls.sign++
      return { rawHex: 'aabb', txid: 'tx123' }
    },
    broadcast: async (rawHex: string) => {
      calls.broadcast.push(rawHex)
      return 'tx123'
    },
  }
  return { svc: new SendService(deps), calls }
}

const utxo = (txid: string, vout: number, value: bigint): GatheredUtxo => ({ txid, vout, value, chain: 0, index: 0, algo: 'ecdsa', address: 'addr', confirmed: true })

const TOKEN = 'aa'.repeat(32)
const tutxo = (txid: string, vout: number, tokenAmount: bigint): GatheredUtxo => ({ txid, vout, value: 0n, chain: 0, index: 0, algo: 'ecdsa', address: 'taddr', confirmed: true, tokenId: TOKEN, tokenAmount })

describe('SendService', () => {
  it('builds a preview with amount, fee and total = amount + fee', async () => {
    const { svc } = harness([utxo('aa', 0, 5_000_000n)])
    const preview = await svc.buildSend(RECIPIENT, 1_000_000n)
    expect(preview.amountAtomic).toBe('1000000')
    expect(BigInt(preview.totalAtomic)).toBe(1_000_000n + BigInt(preview.feeAtomic))
    expect(BigInt(preview.changeAtomic)).toBeGreaterThan(0n)
  })

  it('confirm signs, broadcasts, advances change and returns the txid', async () => {
    const { svc, calls } = harness([utxo('aa', 0, 5_000_000n)])
    await svc.buildSend(RECIPIENT, 1_000_000n)
    const res = await svc.confirmSend()
    expect(res.txid).toBe('tx123')
    expect(calls.sign).toBe(1)
    expect(calls.broadcast).toEqual(['aabb'])
    expect(calls.advance).toBe(1)
  })

  it('excludes frozen coins from automatic selection', async () => {
    // Only the frozen big coin could cover the amount; with it frozen, auto fails.
    const { svc } = harness([utxo('big', 0, 5_000_000n), utxo('small', 0, 100n)], new Set(['big:0']))
    await expect(svc.buildSend(RECIPIENT, 1_000_000n)).rejects.toThrow(/Not enough balance/)
  })

  it('spends exactly the selected coins when outpoints are given', async () => {
    const { svc } = harness([utxo('big', 0, 5_000_000n), utxo('other', 0, 9_000_000n)])
    const preview = await svc.buildSend(RECIPIENT, 1_000_000n, ['big:0'])
    // change = 5_000_000 − 1_000_000 − fee
    expect(BigInt(preview.changeAtomic)).toBe(5_000_000n - 1_000_000n - BigInt(preview.feeAtomic))
  })

  it('refuses to spend a frozen coin even via manual selection', async () => {
    const { svc } = harness([utxo('big', 0, 5_000_000n), utxo('other', 0, 9_000_000n)], new Set(['big:0']))
    await expect(svc.buildSend(RECIPIENT, 1_000_000n, ['big:0'])).rejects.toThrow(/Frozen coins/)
  })

  it('rejects a selection referencing a coin that is no longer available', async () => {
    const { svc } = harness([utxo('aa', 0, 5_000_000n)])
    await expect(svc.buildSend(RECIPIENT, 1_000_000n, ['gone:0'])).rejects.toThrow(/no longer available/)
  })

  it('clears the draft after a successful confirm', async () => {
    const { svc } = harness([utxo('aa', 0, 5_000_000n)])
    await svc.buildSend(RECIPIENT, 1_000_000n)
    await svc.confirmSend()
    await expect(svc.confirmSend()).rejects.toThrow(/No transaction/)
  })

  it('builds a token send (token amount + native ECR fee) and confirms it', async () => {
    const { svc, calls } = harness([utxo('e1', 0, 1_000_000n), tutxo('t1', 0, 100n)])
    const preview = await svc.buildTokenSend(TOKEN, RECIPIENT, 30n)
    expect(preview.tokenId).toBe(TOKEN)
    expect(preview.tokenAmountAtomic).toBe('30')
    expect(BigInt(preview.feeAtomic)).toBeGreaterThan(0n)
    const res = await svc.confirmSend()
    expect(res.txid).toBe('tx123')
    expect(calls.broadcast).toEqual(['aabb'])
    expect(calls.advance).toBeGreaterThanOrEqual(1) // change branch(es) advanced
  })

  it('refuses a token send when there is no ECR to pay the fee', async () => {
    const { svc } = harness([tutxo('t1', 0, 100n)]) // token UTXO only, no native ECR
    await expect(svc.buildTokenSend(TOKEN, RECIPIENT, 30n)).rejects.toThrow(/network fee|balance/i)
  })

  it('refuses a token send when token holdings are short', async () => {
    const { svc } = harness([utxo('e1', 0, 1_000_000n), tutxo('t1', 0, 10n)])
    await expect(svc.buildTokenSend(TOKEN, RECIPIENT, 30n)).rejects.toThrow(/token/i)
  })

  // Regression: the fee estimate must match between automatic selection and an
  // explicit selection of the SAME coins — the bug that showed "insufficient"
  // in manual coin control for a set the automatic path would have sent.
  it('estimates the same fee for auto and manual selection of the same coins', async () => {
    const coins = [utxo('aa', 0, 5_000_000n), utxo('bb', 0, 3_000_000n)]
    const auto = harness(coins).svc
    const manual = harness(coins).svc
    const autoPreview = await auto.buildSend(RECIPIENT, 7_000_000n) // needs both coins
    const manualPreview = await manual.buildSend(RECIPIENT, 7_000_000n, ['aa:0', 'bb:0'])
    expect(manualPreview.feeAtomic).toBe(autoPreview.feeAtomic)
    expect(manualPreview.changeAtomic).toBe(autoPreview.changeAtomic)
  })

  it('maxSendable fee matches a real send-max build (single output, no change)', async () => {
    const coins = [utxo('aa', 0, 5_000_000n), utxo('bb', 0, 3_000_000n)]
    const { svc } = harness(coins)
    const max = await svc.maxSendable()
    // Building send-max should reproduce the same fee and leave no change.
    const preview = await svc.buildSend(RECIPIENT, 0n, undefined, true)
    expect(preview.feeAtomic).toBe(max.feeAtomic)
    expect(preview.changeAtomic).toBe('0')
    expect(preview.amountAtomic).toBe(max.amountAtomic)
  })
})
