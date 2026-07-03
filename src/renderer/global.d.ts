import type { UpdaterApi, WalletApi } from '../shared/protocol'

// The preload exposes exactly this on the renderer's window (contextBridge).
declare global {
  interface Window {
    readonly wallet: WalletApi
    readonly updater: UpdaterApi
  }
}

export {}
