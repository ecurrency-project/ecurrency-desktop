import { describe, expect, it, vi } from 'vitest'
import { unwrapBridge } from '../../src/renderer/lib/bridge'
import { passwordError } from '../../src/renderer/lib/passwordError'
import { fail, ok } from '../../src/shared/protocol'

describe('renderer bridge decoding', () => {
  it('preserves structured password metadata and synchronous unsubscribe functions', async () => {
    const error = Object.assign(new Error('Too many attempts.'), { name: 'UnlockThrottledError', retryAfterMs: 2100 })
    const unsubscribe = vi.fn()
    const api = unwrapBridge<{ check(): Promise<void>; value(): Promise<string>; onEvent(): () => void }>({
      check: async () => structuredClone(fail(error)),
      value: async () => structuredClone(ok('public-value')),
      onEvent: () => unsubscribe,
    })
    const received = await api.check().catch((error: unknown) => error)
    expect(received).toMatchObject({ name: 'UnlockThrottledError', retryAfterMs: 2100 })
    expect(passwordError(received)).toContain('3 seconds')
    expect(await api.value()).toBe('public-value')
    expect(api.onEvent()).toBe(unsubscribe)
  })
})
