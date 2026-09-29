import type { WalletResponse } from './protocol'

// Async bridge methods return plain data. Throwing custom Errors in preload
// loses their name/metadata when Electron copies them across contextBridge.
export type BridgeApi<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer V>
    ? (...args: A) => Promise<WalletResponse<V>>
    : T[K]
}
