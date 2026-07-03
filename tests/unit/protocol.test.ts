import { describe, expect, it } from 'vitest'
import { fail, ok } from '../../src/shared/protocol'

describe('wallet IPC envelope', () => {
  it('wraps a success value', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 })
  })

  it('serialises an Error to a plain { name, message } (no stack / internals leak)', () => {
    const res = fail(new TypeError('bad input'))
    expect(res).toEqual({ ok: false, error: { name: 'TypeError', message: 'bad input' } })
  })

  it('coerces a non-Error throwable', () => {
    const res = fail('boom')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.message).toBe('boom')
  })
})
