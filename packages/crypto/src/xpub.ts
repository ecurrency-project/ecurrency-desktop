// Account-level extended public keys (xpub) for the classical secp256k1 branch.
//
// A watch-only wallet tracks classical addresses from an account xpub —
// m/44'/<coin>'/account' — without the seed: the receive/change chains and the
// address indices below the account are non-hardened, so BIP-32 public derivation
// reproduces every address from the public key alone.
//
// (The Falcon-512 PQ branch is fully hardened and stretches each leaf through HKDF
// into a keygen seed, so it has no xpub; watch-only there relies on an explicit
// list of derived addresses instead.)

import { addressFromPubkey } from './address';
import { nativePath, HDKey } from './bip32';
import type { Network } from './constants';

// Depth of an account node: purpose (44') / coin_type' / account'.
const ACCOUNT_DEPTH = 3;

// The first three levels of the classical leaf path (purpose / coin / account),
// taken from `nativePath` so it can never drift from the leaf derivation scheme.
function accountPath(account: number): string {
  return nativePath(account, 0, 0).split('/').slice(0, ACCOUNT_DEPTH + 1).join('/');
}

/**
 * Export the account-level extended public key (xpub) for the classical branch.
 * Derived from the master key, but carries only public material — safe to hand to
 * a watch-only wallet.
 */
export function exportAccountXpub(master: HDKey, account = 0): string {
  return master.derive(accountPath(account)).publicExtendedKey;
}

/**
 * Parse and validate a classical account xpub, returning the public-only HD node.
 * Throws when the string isn't a valid extended key, carries private material, or
 * isn't at account depth (deriving children from the wrong depth would silently
 * produce the wrong addresses).
 */
export function parseAccountXpub(xpub: string): HDKey {
  const node = HDKey.fromExtendedKey(xpub);
  if (node.privateKey !== null) {
    throw new Error('Expected an extended public key (xpub), got a private key');
  }
  if (node.depth !== ACCOUNT_DEPTH) {
    throw new Error(`Expected an account-level xpub (depth ${ACCOUNT_DEPTH}), got depth ${node.depth}`);
  }
  return node;
}

/** Whether `xpub` is a valid classical account xpub. Never throws. */
export function isValidAccountXpub(xpub: string): boolean {
  try {
    parseAccountXpub(xpub);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive a classical address from a parsed account node (see {@link parseAccountXpub})
 * at chain (0 = receive, 1 = change) and index, via public CKD — no private key.
 */
export function addressFromXpub(account: HDKey, chain: 0 | 1, index: number, network: Network): string {
  const child = account.deriveChild(chain).deriveChild(index);
  if (child.publicKey === null) {
    throw new Error('Derived HD node has no public key');
  }
  return addressFromPubkey(child.publicKey, 'ecdsa', network);
}
