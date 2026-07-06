// Public API of @qbitcoin/crypto.
//
// This file is intentionally small — it only re-exports stable primitives
// that other packages and the extension consume. Internal helpers stay
// internal.

// Encoding primitives.
export { fromHex, toHex } from './encoding/hex';
export {
  decodeVarint,
  encodeVarint,
  type VarintDecodeResult,
} from './encoding/varint';
export {
  decodeVarstr,
  encodeVarstr,
  type VarstrDecodeResult,
} from './encoding/varstr';
export {
  decodeBase58Check,
  encodeBase58Check,
  type Base58CheckDecodeResult,
} from './encoding/base58check';

// Hash primitives.
export {
  checksum32,
  hash160,
  hash256,
  ripemd160,
  sha256,
} from './hashes';

// BIP-39 mnemonics.
export {
  generateMnemonic,
  mnemonicToSeed,
  validateMnemonic,
  type MnemonicLength,
} from './bip39';

// BIP-32 HD derivation (secp256k1 branch).
export {
  COIN_TYPE,
  DERIVATION_SCHEMES,
  HARDENED,
  HDKey,
  SCHEME_QBT_PLACEHOLDER,
  activeScheme,
  derivePath,
  nativePath,
  legacySchemes,
  masterKeyFromSeed,
  schemeById,
  type DerivationScheme,
} from './bip32';

// secp256k1 primitives.
export {
  COMPRESSED_PUBLIC_KEY_BYTES,
  PRIVATE_KEY_BYTES,
  UNCOMPRESSED_PUBLIC_KEY_BYTES,
  getPublicKey,
  isValidPrivateKey,
  isValidPublicKey,
  sign,
  verify,
} from './secp256k1';

// Network constants.
export {
  ADDR_MAGIC,
  ADDRESS_REGEX,
  ALGO_ID,
  ALGO_POSTQUANTUM_BIT,
  DENOMINATOR,
  SIGHASH,
  WIF_VERSION,
  isPostQuantum,
  type Algorithm,
  type Network,
} from './constants';

// Script construction.
export {
  OP_CHECKSIG,
  OP_DUP,
  OP_EQUALVERIFY,
  OP_HASH160,
  OP_HASH256,
  OP_PUSHDATA1,
  OP_PUSHDATA2,
  OP_PUSHDATA4,
  opPushdata,
  scriptP2PK,
  scriptType,
  type ScriptType,
} from './script';

// Address encoding / decoding.
export {
  addressFromPubkey,
  addressFromScripthash,
  decodeAddress,
  scripthashFromPubkey,
  validateAddress,
  type DecodedAddress,
} from './address';

// Account xpub — classical watch-only derivation (public CKD from an account key).
export {
  addressFromXpub,
  exportAccountXpub,
  isValidAccountXpub,
  parseAccountXpub,
} from './xpub';

// Encrypted vault primitives (KDF + AEAD).
export {
  CURRENT_KDF,
  DEFAULT_ARGON2ID_PARAMS,
  DEFAULT_SCRYPT_PARAMS,
  IV_BYTES,
  SALT_BYTES,
  VaultAuthError,
  VaultFormatError,
  deriveKey,
  sealVault,
  unsealVault,
  type Argon2idParams,
  type ScryptParams,
  type SealOptions,
  type VaultBlob,
} from './vault';

// App-data encryption (at-rest, key derived from the seed — for non-key data).
export {
  AppDataError,
  deriveAppDataKey,
  openAppData,
  sealAppData,
  type AppDataBlob,
} from './appData';

// Transaction model & serialization.
export {
  TOKEN_HASH_BYTES,
  TOKEN_TXO_TYPE_TRANSFER,
  TX_TYPE_STANDARD,
  TX_TYPE_TOKENS,
  encodeTokenTransfer,
  serialize,
  serializeForSighash,
  sighash,
  txid,
  type Transaction,
  type TxInput,
  type TxOutput,
} from './transaction';

// Transaction signing.
export {
  decodeSiglistEntry,
  encodeSiglistEntry,
  signTransaction,
  signWithAlgorithm,
  verifySiglistEntry,
  type SigningInput,
} from './signing';

// Signed messages (ecr_signMessage canonical format).
export {
  MESSAGE_MAGIC,
  signMessage,
  signedMessageDigest,
  signedMessagePreimage,
  verifyMessage,
} from './signedMessage';

// HD → Falcon-512 post-quantum derivation (purpose 512' branch).
export {
  FALCON_HD_INFO,
  PURPOSE_FALCON512,
  deriveFalconKeypair,
  nativePqPath,
} from './falconHd';

// Schnorr (BIP-340) primitives + the feature gate for offering it.
export {
  SCHNORR_PUBLIC_KEY_BYTES,
  SCHNORR_SIGNATURE_BYTES,
  isValidSchnorrPublicKey,
  schnorrGetPublicKey,
  schnorrSign,
  schnorrVerify,
} from './schnorr';
export {
  SchnorrDisabledError,
  isSchnorrEnabled,
  setSchnorrEnabled,
} from './features';

// WIF private-key import/export (node-compatible envelope).
export {
  FALCON512_KEYPAIR_BYTES,
  WifError,
  WifNetworkError,
  decodeWif,
  encodeWif,
  falconKeypairFromWifPayload,
  type DecodedWif,
} from './wif';

// Bitcoin addresses (upgrade flow: staging display + Return BTC decode).
export {
  bech32Encode,
  btcP2pkhAddress,
  btcP2pkhAddressForPubkey,
  decodeBtcAddress,
  toWords,
  type BtcAddressKind,
  type BtcNetwork,
  type DecodedBtcAddress,
} from './btc/address';

// Bitcoin transaction construction (upgrade flow: staging → lock spend).
export {
  BTC_RBF_SEQUENCE,
  BTC_SIGHASH_ALL,
  btcSighashAll,
  btcTxid,
  estimateBtcP2pkhTxSize,
  scriptBtcOpReturn,
  scriptBtcP2pkh,
  scriptBtcP2pkhForPubkey,
  serializeBtcTx,
  signBtcP2pkhSpend,
  type BtcOutPoint,
  type BtcTransaction,
  type BtcTxInput,
  type BtcTxOutput,
  type UnsignedBtcSpend,
} from './btc/tx';

// Falcon-512 (WASM-backed once built).
export {
  FALCON512_PRIVATE_KEY_BYTES,
  FALCON512_PUBLIC_KEY_BYTES,
  FALCON512_SEED_BYTES,
  FALCON512_SIG_MAX_BYTES,
  Falcon512NotBuiltError,
  falcon512IsReady,
  falcon512KeygenFromSeed,
  falcon512Sign,
  falcon512Verify,
  setFalcon512WasmSource,
  type Falcon512Keypair,
  type Falcon512WasmSource,
} from './falcon512';
