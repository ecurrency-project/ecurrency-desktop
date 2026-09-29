import type { WalletApi } from '../../shared/protocol'
import { unwrapBridge } from './bridge'

// Single access point to the preload bridge. Screens import `wallet` from here
// instead of reaching for the `window.wallet` global directly, so the dependency
// on the injected API lives in one place (and is easy to mock in future tests).
export const wallet = unwrapBridge<WalletApi>(window.wallet)
