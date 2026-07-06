import { btcP2pkhAddressForPubkey, derivePath, type BtcNetwork, type HDKey } from '@qbitcoin/crypto'

// Staging-key derivation for the BTC→native upgrade flow.
//
// The staging branch is DELIBERATELY the standard Bitcoin BIP-44 legacy
// path — m/44'/0'/0'/0/i — so the user can always recover parked BTC with
// any third-party wallet from the same mnemonic (Electrum/Sparrow:
// "BIP-39 + legacy p2pkh"). That recoverability is the safety story;
// do not move this to a custom path.
//
// Runs in main only. Keys are derived on demand from the unlocked master
// and never persisted; callers that sign must wipe the child afterwards.

/** Coin type 0 = Bitcoin (SLIP-0044) — NOT this chain's coin type. */
export function btcStagingPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`staging index must be a non-negative integer, got ${index}`)
  }
  return `m/44'/0'/0'/0/${index}`
}

export interface BtcStagingKey {
  readonly index: number
  readonly address: string
  readonly publicKey: Uint8Array
  /** Present only on a private master. Callers sign, then call `wipe()`. */
  readonly privateKey: Uint8Array
  /** Zero the private key material (delegates to the underlying node). */
  readonly wipe: () => void
}

/** Derive the staging key at `index`. The caller owns wiping it. */
export function deriveBtcStagingKey(master: HDKey, index: number, network: BtcNetwork): BtcStagingKey {
  const child = derivePath(master, btcStagingPath(index))
  const publicKey = child.publicKey
  const privateKey = child.privateKey
  if (publicKey == null || privateKey == null) {
    throw new Error('Staging derivation requires a private master key')
  }
  return {
    index,
    address: btcP2pkhAddressForPubkey(publicKey, network),
    publicKey,
    privateKey,
    wipe: () => child.wipePrivateData(),
  }
}

/** Address-only variant (no private material touched beyond derivation). */
export function deriveBtcStagingAddress(master: HDKey, index: number, network: BtcNetwork): string {
  const child = derivePath(master, btcStagingPath(index))
  const publicKey = child.publicKey
  if (publicKey == null) throw new Error('Derived HD node has no public key')
  child.wipePrivateData()
  return btcP2pkhAddressForPubkey(publicKey, network)
}
