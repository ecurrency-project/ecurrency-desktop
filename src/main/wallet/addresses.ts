import { addressFromPubkey, deriveFalconKeypair, derivePath, nativePath, type HDKey, type Network } from '@qbitcoin/crypto'

// HD address derivation. The classical (secp256k1/ECDSA) branch is synchronous;
// the post-quantum (Falcon-512) branch is async because it runs WASM keygen.
//
// Runs in the main process only. The caller passes the unlocked master key
// (obtained from the Vault, which never lets it cross the IPC bridge); this
// module derives a child key and returns ONLY the address string. The private
// key is never serialized, logged, or returned.

/** 0 = external/receive chain, 1 = internal/change chain (BIP-44). */
export type Chain = 0 | 1

export interface DeriveOptions {
  /** BIP-44 account index. Defaults to 0. */
  readonly account?: number
  readonly chain: Chain
  readonly index: number
  readonly network: Network
}

/**
 * Derive a classical address at m/44'/<coin>'/account'/chain/index.
 * Throws if the derived node has no public key (should never happen for a key
 * derived from a master seed).
 */
export function deriveClassicalAddress(master: HDKey, opts: DeriveOptions): string {
  const account = opts.account ?? 0
  const child = derivePath(master, nativePath(account, opts.index, opts.chain))
  const pubkey = child.publicKey
  if (pubkey == null) {
    throw new Error('Derived HD node has no public key')
  }
  return addressFromPubkey(pubkey, 'ecdsa', opts.network)
}

/**
 * Derive a post-quantum (Falcon-512) address at m/512'/<coin>'/account'/chain'/index'.
 * Async: Falcon keygen runs in WASM. Only the address string is returned; the
 * Falcon private key is derived, used for the public key, and discarded.
 */
export async function deriveFalconAddress(master: HDKey, opts: DeriveOptions): Promise<string> {
  const account = opts.account ?? 0
  const keypair = await deriveFalconKeypair(master, account, opts.chain, opts.index)
  return addressFromPubkey(keypair.publicKey, 'falcon512', opts.network)
}
