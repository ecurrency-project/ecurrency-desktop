// Readers for the per-network brand strings. The ticker and the address hint
// differ between mainnet and testnet (test coins must never look like real
// ones), so nothing may index `brand.assetLabel` / `brand.addressPlaceholder`
// with a hardcoded network — it goes through here.
//
// Pure and bridge-free on purpose: these live outside lib/walletData (which
// pulls in the preload bridge) so module-level code and node-side tests can
// call them. React code normally wants the `useAssetLabel` /
// `useAddressPlaceholder` hooks from lib/walletData, which track the network.
//
// `null` means "main hasn't reported the build network yet" and reads as
// mainnet: the value is only a label, and the first paint after the answer
// arrives shows the real one.
import { brand } from './index'

export function assetLabelFor(network: 'mainnet' | 'testnet' | null): string {
  return brand.assetLabel[network ?? 'mainnet']
}

export function addressPlaceholderFor(network: 'mainnet' | 'testnet' | null): string {
  return brand.addressPlaceholder[network ?? 'mainnet']
}
