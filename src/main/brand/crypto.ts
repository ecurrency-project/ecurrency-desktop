import { bindProfile } from '@qbtc/crypto'
import { PROFILE } from './profile'

// The chain-bound crypto facade: @qbtc/crypto's profile-dependent functions
// with every chain value pre-filled from ./profile. This is the ONE place the
// app binds its profile — whatever needs a chain value (schemes, address
// magic, WIF versions, HKDF labels, message magic, conversion parameters)
// imports it from here; chain-neutral primitives (hashes, HD math,
// transactions, signing, Bitcoin) come straight from @qbtc/crypto.
//
// Not a brand file: brand branches edit ./profile and ./nodes only.
//
// bindProfile validates the profile up front, so a misconfigured brand fails
// at startup rather than at first use.
export const chain = bindProfile(PROFILE)

// The pre-profile names, so call sites keep their signatures and only change
// the import source. bindProfile returns closures, not methods — destructuring
// them is safe.
export const {
  activeScheme,
  legacySchemes,
  schemeById,
  requireScheme,
  nativePath,
  nativePqPath,
  deriveFalconKeypair,
  exportAccountXpub,
  addressFromScripthash,
  addressFromPubkey,
  validateAddress,
  decodeAddress,
  addressFromXpub,
  encodeWif,
  decodeWif,
  deriveAppDataKey,
  signedMessagePreimage,
  signedMessageDigest,
  signMessage,
  verifyMessage,
  sighashCommitsTokenId,
} = chain

/** Every derivation scheme this chain's wallets know about, in scan priority order. */
export const DERIVATION_SCHEMES = PROFILE.schemes

/**
 * The scheme that owns data persisted BEFORE storage became per-scheme
 * (wallet meta without a `schemes` map, version-1 watch descriptors).
 */
export const META_V1_SCHEME_ID = chain.metaV1SchemeId

/** BTC→native upgrade parameters per network, or null on brands without the flow. */
export const UPGRADE = chain.upgrade

/** Native→BTC downgrade parameters per network, or null on brands without the flow. */
export const DOWNGRADE = chain.downgrade
