// Network-level chain constants.
//
// BRAND FILE: like the node's QBitcoin::Const, brand branches edit these
// values in place (see docs/branding-migration-plan.md). The common base
// carries the QBitcoin network parameters.

/** Which network an object lives on. */
export type Network = 'mainnet' | 'testnet';

/**
 * Signature algorithm. The protocol allows multiple algorithms per
 * address — the byte in the siglist tells the verifier which one to
 * use.
 */
export type Algorithm = 'ecdsa' | 'schnorr' | 'falcon512';

/**
 * Address magic prefix. Prepended to the scripthash before Base58Check
 * encoding the address. NOTE: the prefix length varies per network (the
 * QBitcoin testnet uses 3 bytes) — never assume a fixed length; use
 * `ADDR_MAGIC[network].length`.
 */
export const ADDR_MAGIC: Record<Network, Uint8Array> = {
  mainnet: new Uint8Array([0x13, 0x9d]),
  testnet: new Uint8Array([0x04, 0x73, 0x89]),
};

/**
 * One-byte WIF version prefix for serializing private keys (Bitcoin-
 * compatible). The node wraps Falcon-512 keys in the SAME envelope with a
 * 2178-byte payload (private ‖ public) — see wif.ts.
 */
export const WIF_VERSION: Record<Network, number> = {
  mainnet: 0x80,
  testnet: 0xef,
};

/**
 * Address-shape regular expressions per network. Useful as a *fast
 * pre-filter* before doing the full Base58Check decode.
 *
 * Each network matches two shapes:
 *   - Classical (HASH160-based): bq… (35 chars) / btq… (36 chars)
 *   - Post-quantum (HASH256-based): 3u[H-K]… (52) / 3ua[2-4]… (53)
 *
 * The character classes are the EXACT reachable ranges, computed from
 * the magic bytes: base58(magic ‖ hash ‖ checksum) over all hashes spans
 * bqM…–bqk… / 3uHA…–3uK7… on mainnet and btqR…–btqp… / 3ua2…–3ua4… on
 * testnet. Matches the node's ADDRESS_RE / ADDRESS_TESTNET_RE.
 */
export const ADDRESS_REGEX: Record<Network, RegExp> = {
  mainnet:
    /^(?:bq[1-9A-HJ-NP-Za-km-z]{33}|3u[H-K][1-9A-HJ-NP-Za-km-z]{49})$/,
  testnet:
    /^(?:btq[1-9A-HJ-NP-Za-km-z]{33}|3ua[2-4][1-9A-HJ-NP-Za-km-z]{49})$/,
};

/**
 * Numeric algorithm IDs used in the byte that prefixes signatures inside
 * a siglist. Matches the `CRYPT_ALGO_*` constants in the node.
 */
export const ALGO_ID: Record<Algorithm, number> = {
  ecdsa: 1,
  schnorr: 2,
  falcon512: 129, // 0x80 (postquantum bit) | 1
};

/** Bit flag marking algorithms as post-quantum. */
export const ALGO_POSTQUANTUM_BIT = 0x80;

/** True if `algo` has the post-quantum bit set in its numeric ID. */
export function isPostQuantum(algo: Algorithm): boolean {
  return (ALGO_ID[algo] & ALGO_POSTQUANTUM_BIT) !== 0;
}

/** Atomic units per coin — `100_000_000` (1 coin = 10⁸ atomic, like satoshis). */
export const DENOMINATOR = 100_000_000;

/**
 * Parameters of the BTC→native upgrade path (the chain credits native
 * coins for BTC paid into its lock script). BRAND VALUE: null when the
 * brand has no Bitcoin upgrade; brand branches fill in their consensus
 * values. The wallet's upgrade flow stays dormant while this is null.
 */
export interface UpgradeChainConfig {
  /** Exact scriptPubKey (hex) of the chain's BTC lock/freeze output. */
  readonly lockScriptHex: string;
  /** Smallest convertible amount, in satoshi. */
  readonly minConvertValue: bigint;
  /** Below this, change folds into the fee instead of creating an output. */
  readonly dustLimit: bigint;
  /** Fee-estimate confirmation target, in blocks. */
  readonly feeTargetBlocks: number;
  /** sat/vB used when the fee oracle has no usable answer. */
  readonly fallbackFeeRate: number;
}

/**
 * Per-network upgrade parameters, keyed by the NATIVE network the wallet
 * runs on. The node derives its BTC lock script per network (mainnet
 * locks on Bitcoin mainnet, testnet on Bitcoin testnet4), so the lock
 * script — and potentially the limits — differ between the two.
 */
export const UPGRADE: Readonly<Record<Network, UpgradeChainConfig>> | null = null;

/** Consensus parameters of the native→BTC downgrade (see downgrade.ts). */
export interface DowngradeChainConfig {
  /** The chain's lock pubkey (hex, compressed) — the only key allowed to
   *  move a freeze into a downgrade (the freeze script's IF branch). */
  readonly lockPubkeyHex: string;
  /** Seconds until the user may reclaim an unpicked freeze output. */
  readonly freezeSeconds: number;
  /** Seconds until the user may reclaim an unburned downgrade output. */
  readonly outputSeconds: number;
}

/**
 * Per-network downgrade parameters, keyed by the NATIVE network — or null
 * on brands without the flow (the reverse Convert direction stays hidden).
 */
export const DOWNGRADE: Readonly<Record<Network, DowngradeChainConfig>> | null = null;

/**
 * Whether transaction sign data commits the token id. A newer node appends
 * the raw 32-byte token hash after the outputs ("Add token_hash to
 * transaction sign data") and rejects token-transfer signatures that omit
 * it; an older node rejects signatures that append it. BRAND VALUE — flip
 * only in lockstep with the brand's node deployment.
 */
export const SIGHASH_COMMITS_TOKEN_ID = false;

/**
 * SIGHASH types accepted by the protocol. The wallet only ever emits
 * `SIGHASH_ALL`. Other modes are listed for completeness so decoders /
 * verifiers can reject them explicitly.
 */
export const SIGHASH = {
  ALL: 1,
  NONE: 2,
  SINGLE: 3,
  ANYONECANPAY: 0x80, // flag, combined with one of the above
} as const;
