// address encoding, decoding, and validation.
//
//
// Address format on the wire:
//
//   address = base58( ADDR_MAGIC || scripthash || checksum (4) )
//
// The magic prefix length is per-network (see ADDR_MAGIC) — 2 bytes on
// mainnet, 3 on testnet — so decoding always takes it from the constant.
//
// where:
//   - scripthash = HASH160(p2pk_script)  for classical (ECDSA, Schnorr)
//   - scripthash = HASH256(p2pk_script)  for post-quantum (Falcon-512)
//   - checksum   = first 4 bytes of HASH256(magic || scripthash)
//   - p2pk_script = pushdata(pubkey) || OP_CHECKSIG  (see script.ts)
//
// All real-world test vectors below come from the live mainnet mempool.

import {
  ADDRESS_REGEX,
  ADDR_MAGIC,
  type Algorithm,
  isPostQuantum,
  type Network,
} from './constants';
import {
  decodeBase58Check,
  encodeBase58Check,
} from './encoding/base58check';
import { toHex } from './encoding/hex';
import { hash160, hash256 } from './hashes';
import { scriptP2PK } from './script';

const HASH160_LEN = 20;
const HASH256_LEN = 32;

/** Hash a P2PK script using the right hash function for the algorithm. */
export function scripthashFromPubkey(
  pubkey: Uint8Array,
  algo: Algorithm,
): Uint8Array {
  const script = scriptP2PK(pubkey);
  return isPostQuantum(algo) ? hash256(script) : hash160(script);
}

/**
 * Build an address from a raw scripthash.
 *
 * For classical addresses the scripthash is 20 bytes (HASH160 output);
 * for PQ addresses it's 32 bytes (HASH256). Callers normally don't
 * compute scripthashes themselves — use `addressFromPubkey` instead.
 */
export function addressFromScripthash(
  scripthash: Uint8Array,
  network: Network,
): string {
  if (
    scripthash.length !== HASH160_LEN &&
    scripthash.length !== HASH256_LEN
  ) {
    throw new RangeError(
      `Scripthash must be ${HASH160_LEN} or ${HASH256_LEN} bytes, got ${scripthash.length}`,
    );
  }
  return encodeBase58Check(ADDR_MAGIC[network], scripthash);
}

/**
 * Derive an address from a public key.
 *
 * The algorithm parameter decides which hash function is applied to the
 * P2PK script — `HASH160` for classical, `HASH256` for post-quantum.
 * This is the standard path most callers use.
 */
export function addressFromPubkey(
  pubkey: Uint8Array,
  algo: Algorithm,
  network: Network,
): string {
  return addressFromScripthash(scripthashFromPubkey(pubkey, algo), network);
}

/**
 * Validate an address string for the given network.
 *
 * Performs both:
 *   1. Cheap regex check on the address shape and prefix character
 *   2. Full Base58Check decode with magic-prefix and checksum verification
 *
 * Returns `true` only if both pass. Never throws.
 */
export function validateAddress(address: string, network: Network): boolean {
  if (!ADDRESS_REGEX[network].test(address)) return false;
  try {
    const { version } = decodeBase58Check(address, ADDR_MAGIC[network].length);
    return toHex(version) === toHex(ADDR_MAGIC[network]);
  } catch {
    return false;
  }
}

export interface DecodedAddress {
  /** The scripthash bytes (20 or 32 depending on type). */
  scripthash: Uint8Array;
  /** Which network this address belongs to. */
  network: Network;
  /** 'classical' (HASH160-based) or 'pq' (HASH256-based). */
  type: 'classical' | 'pq';
}

/**
 * Decode an address into its components, inferring the network and
 * scripthash type from the string.
 *
 * Throws if the address doesn't match any known network or its
 * checksum is invalid.
 */
export function decodeAddress(address: string): DecodedAddress {
  const networks: Network[] = ['mainnet', 'testnet'];
  for (const network of networks) {
    if (!ADDRESS_REGEX[network].test(address)) continue;
    const { version, payload } = decodeBase58Check(address, ADDR_MAGIC[network].length);
    if (toHex(version) !== toHex(ADDR_MAGIC[network])) continue;

    let type: 'classical' | 'pq';
    if (payload.length === HASH160_LEN) {
      type = 'classical';
    } else if (payload.length === HASH256_LEN) {
      type = 'pq';
    } else {
      throw new Error(
        `Unexpected scripthash length: ${payload.length} bytes`,
      );
    }

    return { scripthash: payload, network, type };
  }
  throw new Error(`Address does not match any known network: ${address}`);
}
