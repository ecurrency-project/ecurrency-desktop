import { coinTypeFor, type ChainProfile, type DerivationScheme } from '@qbtc/crypto'

// The chain profile: everything that makes this build's chain THIS chain from
// the wallet-crypto perspective — derivation schemes, address magic, WIF
// versions, HKDF labels, signed-message magic, conversion parameters.
// @qbtc/crypto ships no chain constants; this file injects ours, and ./crypto
// binds it into the facade the rest of main imports.
//
// BRAND FILE: like the node's chain parameters, brand branches edit these
// values in place. This is the eCurrency (ECR) brand.
//
// FROZEN on a shipped brand: every value here except the `upgrade` display
// limits is consensus- or storage-affecting — changing schemes, magic, HKDF
// labels or WIF versions after shipping strands user funds or data. Pin
// tests: tests/unit/brand/profile.test.ts.

/**
 * The original scheme eCurrency shipped on, before SLIP-0044 assigned an
 * official coin_type. LEGACY, PERMANENT: wallets created on it hold funds
 * at these paths forever — it is scanned and spendable for the lifetime
 * of the product, but no fresh addresses derive here. The id is persisted
 * in wallet storage and must never change, byte for byte.
 */
export const SCHEME_ECR_PLACEHOLDER: DerivationScheme = {
  id: 'ecr-v1-placeholder',
  coinType: 999,
  label: 'eCurrency v1 (pre-SLIP-0044)',
  status: 'legacy',
  pathTemplate: (account, change, index, _network) =>
    `m/44'/999'/${account}'/${change}/${index}`,
}

/**
 * The official SLIP-0044 scheme — active: every new receive/change address
 * derives here, on both the classical and the Falcon (purpose 512')
 * branches. coin_type 8128 is eCurrency's registered SLIP-0044 number;
 * like the id, it is frozen forever — funds live at these paths.
 */
export const SCHEME_ECR_V2: DerivationScheme = {
  id: 'ecr-v2-slip44',
  // 8128 is eCurrency's registered SLIP-0044 number; testnet follows the
  // BIP-44 convention with the shared testnet coin_type 1. Safe to adopt
  // per-network here because no ECR testnet wallet ever existed — testing
  // always ran against production nodes. v1 stays a plain 999 everywhere:
  // it is the frozen legacy scheme and never derives fresh addresses.
  coinType: { mainnet: 8128, testnet: 1 },
  label: 'eCurrency v2 (SLIP-0044)',
  status: 'active',
  pathTemplate: (account, change, index, network) =>
    `m/44'/${coinTypeFor(SCHEME_ECR_V2, network)}'/${account}'/${change}/${index}`,
}

export const PROFILE: ChainProfile = {
  /** Diagnostics-only label (error messages). Not consensus. */
  name: 'ecurrency',

  /**
   * Two-byte address magic prefix per network, prepended to the scripthash
   * before Base58Check encoding.
   */
  addrMagic: {
    mainnet: Uint8Array.of(0x07, 0x6e),
    testnet: Uint8Array.of(0x07, 0xd1),
  },

  /**
   * Address-shape pre-filter per network. Two shapes each: classical
   * (HASH160-based, 35 chars) EC… / Et…, post-quantum (HASH256-based, 52
   * chars) 26[k-n]… / 2A[4-6]…. The character classes are the EXACT
   * reachable ranges for the magic bytes above: base58(magic ‖ hash ‖
   * checksum) for all 2^256 hashes spans 26kE…–26nB… on mainnet and
   * 2A4g…–2A6d… on testnet. Matches the node exactly (its testnet range
   * once said `2A[678]`; fixed to `2A[456]` in the node's chain parameters
   * after our report, 2026-07).
   */
  addressRegex: {
    mainnet: /^(?:EC[1-9A-HJ-NP-Za-km-z]{33}|26[k-n][1-9A-HJ-NP-Za-km-z]{49})$/,
    testnet: /^(?:Et[1-9A-HJ-NP-Za-km-z]{33}|2A[4-6][1-9A-HJ-NP-Za-km-z]{49})$/,
  },

  /** One-byte WIF version prefixes (Bitcoin-compatible envelope). */
  wifVersion: { mainnet: 0x80, testnet: 0xef },

  /**
   * Every derivation scheme this chain's wallets know about, in scan
   * priority order for funds discovery: the active v2 first, the legacy v1
   * second. Exactly one is 'active'.
   */
  schemes: [SCHEME_ECR_V2, SCHEME_ECR_PLACEHOLDER],

  /**
   * The scheme that owns data persisted BEFORE storage became per-scheme
   * (wallet meta without a `schemes` map, version-1 watch descriptors): the
   * ORIGINAL v1 scheme, forever — re-attributing old blobs would shift
   * issued-index floors onto the wrong branch.
   */
  metaV1SchemeId: SCHEME_ECR_PLACEHOLDER.id,

  /** HKDF label of the Falcon-512 keygen-seed derivation. Versioned. */
  falconHdInfo: 'ecr/pq/falcon512/v1',
  /** HKDF label of the app-data (address book etc.) encryption key. */
  appDataInfo: 'ecr/app-data/v1',
  /** Signed-message magic prefix — Bitcoin's convention, eCurrency-branded. */
  messageMagic: 'eCurrency Signed Message:\n',

  /**
   * BTC→native upgrade and native→BTC downgrade parameters per NATIVE
   * network, or null while the brand has no conversion flow — the Convert
   * screen stays dormant then.
   */
  upgrade: null,
  downgrade: null,

  /**
   * When transaction sign data starts committing the token id, per network
   * (unix seconds): 0 = since genesis, null = never. Must mirror the brand
   * node's fork schedule — before the fork the node rejects signatures that
   * commit the id, after it those that omit it.
   */
  tokenSighashFork: { mainnet: 0, testnet: 0 },
}
