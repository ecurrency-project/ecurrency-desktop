// BIP-32 hierarchical deterministic key derivation for secp256k1.
//
// Thin wrapper over @scure/bip32, plus the chain-specific derivation
// scheme registry.
//
// BRAND FILE: the derivation scheme (coin_type, scheme id) is a brand
// value — brand branches edit it in place. Scheme `id`s are persisted in
// wallet storage, so a brand must never change its id once shipped.
//
// Why a registry instead of a single hardcoded path: SLIP-0044 (the
// industry coin_type list) hasn't assigned these chains a number yet.
// Until it does, we use a placeholder. When the official number lands,
// we add a new scheme alongside the placeholder and migrate funds.
//
//
// The Falcon-512 PQ branch derives BIP-32 leaves under purpose 512'
// (same coin_type, fully hardened) and stretches them into Falcon
// keygen seeds via HKDF — see `falconHd.ts`.

import { HDKey } from '@scure/bip32';

export { HDKey };

/**
 * Construct a BIP-32 master HD key from a 64-byte BIP-39 seed.
 *
 * `seed.length` must be in [16, 64] per BIP-32. In practice BIP-39 always
 * produces 64 bytes, so any other length is almost certainly a caller
 * bug — @scure/bip32 will throw.
 */
export function masterKeyFromSeed(seed: Uint8Array): HDKey {
  return HDKey.fromMasterSeed(seed);
}

/**
 * Derive a child key from `parent` along `path`.
 *
 * Path syntax: BIP-32 conventional, "m/<index>[']/<index>['].../"
 *  - leading `m/` is optional
 *  - `'` (or `h`) after an index marks hardened derivation
 *
 * Throws on malformed paths or out-of-range indices.
 */
export function derivePath(parent: HDKey, path: string): HDKey {
  return parent.derive(path);
}

// ─── Derivation scheme registry ───────────────────────────────────────

/** Bit mask for hardened BIP-32 indices. Useful when constructing
 *  indices manually via `HDKey.deriveChild(n)`; with string paths the
 *  trailing `'` (or `h`) handles this for you. */
export const HARDENED = 0x80000000;

/**
 * A specific BIP-44 derivation scheme. The wallet may know about
 * several over its lifetime.
 *
 *  - `id` is a stable string identifier used in storage and APIs.
 *  - `coinType` is the BIP-44 coin_type number (unhardened — the `'`
 *    in the path string adds the hardened bit at parse time).
 *  - `status: 'active'` means new addresses are derived under this
 *    scheme. `'legacy'` means we still scan for funds here but don't
 *    create fresh addresses.
 *  - `pathTemplate` builds the BIP-44 path string for a given
 *    account/change/index triple.
 */
export interface DerivationScheme {
  readonly id: string;
  readonly coinType: number;
  readonly label: string;
  readonly status: 'active' | 'legacy';
  readonly pathTemplate: (
    account: number,
    change: 0 | 1,
    index: number,
  ) => string;
}

/**
 * The placeholder scheme used until the chain registers an official
 * SLIP-0044 coin_type. After registration, this entry's `status` flips
 * to `'legacy'` and a new active scheme is added.
 *
 * TODO(qbitcoin): the QBitcoin coin_type is being obtained; coinType 1
 * (SLIP-0044 "testnet, all coins") is a stand-in until then. Do NOT ship
 * a release that derives real funds from this scheme.
 */
export const SCHEME_QBT_PLACEHOLDER: DerivationScheme = {
  id: 'qbt-v1-placeholder',
  coinType: 1,
  label: 'QBitcoin v1 (pre-SLIP-0044)',
  status: 'active',
  pathTemplate: (account, change, index) =>
    `m/44'/1'/${account}'/${change}/${index}`,
};

/**
 * The complete list of derivation schemes the wallet knows about.
 *
 * Order in this array determines scan priority during seed import: the
 * wallet checks schemes from first to last, finds UTXOs on each, and
 * reports total balance. The single `'active'` scheme is used for new
 * address generation.
 *
 * INVARIANT: exactly one scheme has `status: 'active'`. The
 * `activeScheme()` helper enforces this at runtime.
 */
export const DERIVATION_SCHEMES: readonly DerivationScheme[] = [
  SCHEME_QBT_PLACEHOLDER,
];

/**
 * Return the currently active derivation scheme. Throws if zero or more
 * than one scheme is marked active — both are programming errors.
 */
export function activeScheme(): DerivationScheme {
  const actives = DERIVATION_SCHEMES.filter((s) => s.status === 'active');
  if (actives.length !== 1) {
    throw new Error(
      `Exactly one active derivation scheme required, found ${actives.length}`,
    );
  }
  return actives[0]!;
}

/** All legacy schemes — used for funds-discovery during seed import. */
export function legacySchemes(): readonly DerivationScheme[] {
  return DERIVATION_SCHEMES.filter((s) => s.status === 'legacy');
}

/** Look up a scheme by its stable id. Returns undefined if not found. */
export function schemeById(id: string): DerivationScheme | undefined {
  return DERIVATION_SCHEMES.find((s) => s.id === id);
}

/**
 * Look up a scheme by id, throwing on an unknown one. Use where an unknown
 * id is a data-integrity error (e.g. resolving the scheme of a UTXO about
 * to be signed) rather than an expected miss.
 */
export function requireScheme(id: string): DerivationScheme {
  const scheme = schemeById(id);
  if (scheme === undefined) {
    throw new Error(`Unknown derivation scheme '${id}'`);
  }
  return scheme;
}

/**
 * The scheme that owns data persisted BEFORE storage became per-scheme
 * (wallet meta without a `schemes` map, version-1 watch descriptors):
 * whatever scheme was active when those formats were written.
 *
 * BRAND VALUE (follows the scheme registry above): when a brand adds a new
 * active scheme, this stays pointing at the ORIGINAL scheme — pre-existing
 * blobs on disk were written under it, and re-attributing them would shift
 * issued-index floors onto the wrong branch.
 */
export const META_V1_SCHEME_ID: string = SCHEME_QBT_PLACEHOLDER.id;

// ─── Convenience aliases ──────────────────────────────────────────────

/** The active coin_type number. Convenience over `activeScheme().coinType`. */
export const COIN_TYPE: number = activeScheme().coinType;

/**
 * Standard BIP-44 path for a classical (secp256k1) address
 * under the *active* scheme.
 *
 *   m / 44' / <active coin_type>' / account' / change / index
 *
 * `change = 0` is the receive chain, `change = 1` is the change chain
 * (used internally to receive transaction change so it doesn't pile up
 * on the receive addresses).
 */
export function nativePath(
  account: number,
  index: number,
  change: 0 | 1 = 0,
): string {
  return nativePathFor(activeScheme(), account, index, change);
}

/**
 * {@link nativePath} for an EXPLICIT scheme — the multi-scheme form used by
 * discovery and signing, where the address's own scheme (not necessarily the
 * active one) decides the path. Argument order matches `nativePath`.
 */
export function nativePathFor(
  scheme: DerivationScheme,
  account: number,
  index: number,
  change: 0 | 1 = 0,
): string {
  return scheme.pathTemplate(account, change, index);
}
