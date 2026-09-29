import type { BridgeApi } from '../../shared/bridge'
import type { WalletResponse } from '../../shared/protocol'

export function unwrapResponse<T>(response: WalletResponse<T>): T {
  if (response.ok) return response.value
  const error = new Error(response.error.message)
  error.name = response.error.name
  if (response.error.retryAfterMs !== undefined) Object.assign(error, { retryAfterMs: response.error.retryAfterMs })
  throw error
}

export function unwrapBridge<T extends object>(api: BridgeApi<T>): T {
  return Object.fromEntries(Object.entries(api).map(([name, method]) => [name, (...args: unknown[]) => {
    if (typeof method !== 'function') throw new TypeError('Invalid bridge method')
    const result = method(...args)
    // Subscription methods stay synchronous and return only an unsubscribe.
    return result instanceof Promise ? result.then(unwrapResponse) : result
  }])) as T
}
