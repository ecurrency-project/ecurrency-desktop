// HD → Falcon-512 derivation — the wallet's post-quantum address branch.
//
// Falcon has no BIP-32, so we bridge BIP-32 path structure to Falcon's
// seeded keygen. PQ keys are deterministic and recoverable from the same
// BIP-39 mnemonic as the classical branch:
//
//   child   = derivePath(master, m/512'/<coin_type>'/account'/change'/index')
//   ikm     = child.privateKey            // 32 B; never used as a secp256k1 key
//   seed48  = HKDF-SHA256(ikm, salt=∅, info=FALCON_HD_INFO (see below), L=48)
//   keypair = falcon512KeygenFromSeed(seed48)
//
// Design notes:
//  - The branch is separated from classical at the PURPOSE level (512' —
//    self-documenting for Falcon-512), not by a second coin_type:
//    SLIP-0044 assigns one number per coin, and both branches must
//    migrate together when the official coin_type lands.
//  - Every level is hardened. Watch-only xpub derivation is impossible
//    for Falcon anyway (keygen needs the private seed), so non-hardened
//    levels would buy nothing — hardening is free isolation. Even an
//    adversary holding revealed classical keys cannot reach this subtree.
//  - The BIP-32 leaf private key is used ONLY as HKDF input keying
//    material; the info label domain-separates it from the app-data key
//    and from any future PQ scheme (bump the v1 suffix only with a
//    migration).
//
// CONSENSUS-FOR-RECOVERABILITY: this mapping must stay byte-stable
// forever — changing any stage (path, info label, HKDF, keygen) strands
// existing PQ funds. Golden vectors in falconHd.test.ts freeze it.

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

import {
  activeScheme,
  coinTypeFor,
  derivePath,
  type DerivationScheme,
  type HDKey,
} from './bip32';
import type { Network } from './constants';
import {
  FALCON512_SEED_BYTES,
  falcon512KeygenFromSeed,
  type Falcon512Keypair,
} from './falcon512';

/** BIP-43 purpose for the Falcon-512 branch. Project-defined (there is
 *  no BIP for PQ derivation); 512 is self-documenting. The classical
 *  branch stays on purpose 44'. */
export const PURPOSE_FALCON512 = 512;

/** HKDF `info` — domain separation for the Falcon-512 keygen seed.
 *  Versioned: a future PQ scheme bumps the suffix and adds a migration.
 *  BRAND VALUE: part of the derivation scheme — each brand sets its own
 *  label, and once a brand has shipped, its label must never change
 *  (existing PQ funds would become unrecoverable). */
export const FALCON_HD_INFO = 'qbt/pq/falcon512/v1';

/**
 * BIP-32 path of a Falcon-512 leaf:
 *
 *   m / 512' / <active coin_type>' / account' / change' / index'
 *
 * Mirrors `nativePath` (same argument order, same `(account, change,
 * index)` space, same receive/change rotation semantics) but is fully
 * hardened and lives under purpose 512'. The coin_type is shared with
 * the classical branch — both migrate together through the derivation
 * scheme registry when the official SLIP-0044 number lands.
 */
export function nativePqPath(
  account: number,
  index: number,
  network: Network,
  change: 0 | 1 = 0,
): string {
  return nativePqPathFor(activeScheme(), account, index, network, change);
}

/**
 * {@link nativePqPath} for an EXPLICIT scheme — used when deriving on a
 * legacy scheme's branch (its coin_type differs from the active one). The
 * path shape and the HKDF stage are identical across schemes; only the
 * coin_type level changes (and, within a scheme, the network may select
 * the BIP-44 testnet coin_type).
 */
export function nativePqPathFor(
  scheme: DerivationScheme,
  account: number,
  index: number,
  network: Network,
  change: 0 | 1 = 0,
): string {
  return `m/${PURPOSE_FALCON512}'/${coinTypeFor(scheme, network)}'/${account}'/${change}'/${index}'`;
}

/**
 * Derive the Falcon-512 keypair at `(account, change, index)` from a
 * BIP-32 master key.
 *
 * The BIP-32 leaf at {@link nativePqPath} provides 32 bytes of input keying
 * material; HKDF-SHA256 stretches it to Falcon's 48-byte keygen seed
 * under the {@link FALCON_HD_INFO} label; keygen is then fully
 * deterministic. The leaf key and the seed are wiped before returning.
 *
 * `scheme` selects the coin_type level of the leaf path; it defaults to the
 * active scheme. Discovery/signing on a legacy branch passes that branch's
 * scheme explicitly. The HKDF info label is scheme-independent (versioned
 * separately — see the header notes).
 *
 * Returns `{ publicKey (897 B), privateKey (1281 B) }`.
 */
export async function deriveFalconKeypair(
  master: HDKey,
  account: number,
  change: 0 | 1,
  index: number,
  network: Network,
  scheme: DerivationScheme = activeScheme(),
): Promise<Falcon512Keypair> {
  const child = derivePath(master, nativePqPathFor(scheme, account, index, network, change));
  const ikm = child.privateKey;
  if (ikm === null) {
    // Unreachable from a seed-built master (hardened derivation already
    // requires a private key), but guards the public-key-only case.
    throw new Error('Falcon derivation requires a private BIP-32 master key');
  }
  const seed = hkdf(sha256, ikm, undefined, FALCON_HD_INFO, FALCON512_SEED_BYTES);
  child.wipePrivateData(); // zeroes ikm — already consumed by HKDF
  try {
    return await falcon512KeygenFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}
