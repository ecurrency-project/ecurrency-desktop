import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it } from 'vitest'
import {
  coinTypeFor,
  derivePath,
  falcon512KeygenFromSeed,
  FALCON512_SEED_BYTES,
  fromHex,
  getPublicKey,
  masterKeyFromSeed,
  mnemonicToSeed,
  nativePathFor,
  toHex,
  validateProfile,
  type Network,
} from '@qbtc/crypto'
import {
  activeScheme,
  addressFromPubkey,
  addressFromScripthash,
  decodeAddress,
  decodeWif,
  deriveAppDataKey,
  deriveFalconKeypair,
  DERIVATION_SCHEMES,
  DOWNGRADE,
  encodeWif,
  legacySchemes,
  META_V1_SCHEME_ID,
  nativePath,
  nativePqPath,
  requireScheme,
  schemeById,
  sighashCommitsTokenId,
  signedMessageDigest,
  signedMessagePreimage,
  UPGRADE,
  validateAddress,
} from '../../../src/main/brand/crypto'
import { PROFILE, SCHEME_ECR_PLACEHOLDER, SCHEME_ECR_V2 } from '../../../src/main/brand/profile'

// Pins of this build's chain profile and of the facade bound to it. BRAND
// TEST: brand branches replace the expected values in their own stack — the
// assertions keep their shape. On a shipped brand a failing pin means someone
// touched a frozen value: fix the profile, never the pin.

const NETWORKS: readonly Network[] = ['mainnet', 'testnet']
/** The standard BIP-39 test mnemonic. */
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED = mnemonicToSeed(MNEMONIC)
const master = () => masterKeyFromSeed(SEED)
const PRIV = fromHex('11'.repeat(32))

describe('chain profile', () => {
  it('is internally consistent', () => {
    expect(() => validateProfile(PROFILE)).not.toThrow()
  })

  it('pins the network constants', () => {
    expect(toHex(PROFILE.addrMagic.mainnet)).toBe('076e')
    expect(toHex(PROFILE.addrMagic.testnet)).toBe('07d1')
    expect(PROFILE.wifVersion).toEqual({ mainnet: 0x80, testnet: 0xef })
    expect(PROFILE.addressRegex.mainnet.source).toBe('^(?:EC[1-9A-HJ-NP-Za-km-z]{33}|26[k-n][1-9A-HJ-NP-Za-km-z]{49})$')
    expect(PROFILE.addressRegex.testnet.source).toBe('^(?:Et[1-9A-HJ-NP-Za-km-z]{33}|2A[4-6][1-9A-HJ-NP-Za-km-z]{49})$')
  })

  it('pins the derivation schemes, ids and coin_types byte-exact', () => {
    // v2 (8128, the registered SLIP-0044 number; BIP-44 testnet coin_type 1)
    // is active; v1 (999 everywhere) is the frozen legacy scheme that shipped
    // wallets hold funds on. Both stay registered forever, ids byte-exact:
    // the ids are persisted in wallet storage and the paths hold user funds.
    expect(DERIVATION_SCHEMES.map((s) => [s.id, s.status])).toEqual([
      ['ecr-v2-slip44', 'active'],
      ['ecr-v1-placeholder', 'legacy'],
    ])
    expect(activeScheme()).toBe(SCHEME_ECR_V2)
    expect(legacySchemes()).toEqual([SCHEME_ECR_PLACEHOLDER])
    expect(schemeById('ecr-v1-placeholder')).toBe(SCHEME_ECR_PLACEHOLDER)
    expect(requireScheme('ecr-v2-slip44')).toBe(SCHEME_ECR_V2)
    expect(schemeById('ecr-v3-official')).toBeUndefined()
    // Pre-per-scheme blobs (v1 meta, v1 watch descriptors) belong to v1.
    expect(META_V1_SCHEME_ID).toBe('ecr-v1-placeholder')

    expect(coinTypeFor(SCHEME_ECR_V2, 'mainnet')).toBe(8128)
    expect(coinTypeFor(SCHEME_ECR_V2, 'testnet')).toBe(1)
    expect(coinTypeFor(SCHEME_ECR_PLACEHOLDER, 'mainnet')).toBe(999)
    expect(coinTypeFor(SCHEME_ECR_PLACEHOLDER, 'testnet')).toBe(999)

    expect(nativePath(0, 0, 'mainnet')).toBe("m/44'/8128'/0'/0/0")
    expect(nativePath(1, 2, 'testnet', 1)).toBe("m/44'/1'/1'/1/2")
    expect(nativePqPath(0, 0, 'mainnet')).toBe("m/512'/8128'/0'/0'/0'")
    expect(nativePqPath(1, 2, 'testnet', 1)).toBe("m/512'/1'/1'/1'/2'")
    expect(nativePathFor(SCHEME_ECR_PLACEHOLDER, 0, 0, 'mainnet')).toBe("m/44'/999'/0'/0/0")
    expect(nativePathFor(SCHEME_ECR_PLACEHOLDER, 0, 0, 'testnet')).toBe("m/44'/999'/0'/0/0")
  })

  it('pins the HKDF labels and the signed-message magic', () => {
    expect(PROFILE.falconHdInfo).toBe('ecr/pq/falcon512/v1')
    expect(PROFILE.appDataInfo).toBe('ecr/app-data/v1')
    expect(PROFILE.messageMagic).toBe('eCurrency Signed Message:\n')
  })

  it("has no conversion flow and switches the token-id commitment at the node's fork times", () => {
    expect(UPGRADE).toBeNull()
    expect(DOWNGRADE).toBeNull()
    // Detailed boundary checks in ./tokenSighash.test.ts.
    expect(PROFILE.tokenSighashFork).toEqual({ mainnet: 1_789_430_400, testnet: 1_788_220_800 })
    expect(sighashCommitsTokenId('mainnet', 1_789_430_399)).toBe(false)
    expect(sighashCommitsTokenId('mainnet', 1_789_430_400)).toBe(true)
  })
})

describe('bound facade — goldens from the test mnemonic and the key 0x11…11', () => {
  const PINS: Record<
    Network,
    { classical: string; pqFromScripthash: string; wif: string; falconSeed: string; falconAddress: string }
  > = {
    mainnet: {
      classical: 'ECgBKnhFvDm7qi6kCxo2suAD6W8Uavhq5VB',
      pqFromScripthash: '26mYVdXUY6JJhLyfh32DKZ54JhzhRWVPHMWSmnsecWtfUoSDeUf9',
      wif: '5HwoXVkHoRM8sL2KmNRS217n1g8mPPBomrY7yehCuXC1115WWsh',
      // THESE VALUES FREEZE THE SCHEME: the seed at m/512'/8128'/0'/0'/0' is
      // the input to Falcon keygen — if it moves, PQ funds stop being
      // recoverable from their mnemonic. A failure is a derivation break to
      // revert, not a pin to update. (The v1 branch is pinned in
      // ./falconHd.test.ts.)
      falconSeed: '0ff9de10602fbe7bc6c41bef89ef2d24a6bd98a1da7ca1cd99449ac3e562411ff59eaa1dd91cd286c999b593624709d5',
      falconAddress: '26kn6raUwMh11AUUHaUX6wJCxwvdC84Yje5wtDfruzo12Rhm6fsr',
    },
    testnet: {
      classical: 'EtWe3GSmSWczag1YnPL1Rua9yp4yyGfvYdv',
      pqFromScripthash: '2A5zC6UuhTRG7hCCWnQfEypQyNHfWsCoyFnTRwhkMvmKsf5iD7gZ',
      wif: '91iS7EZqPeRGqPXcPiKLtbfjfLVUYYj17oQ54H3iFFw3n1UmZSS',
      // BIP-44 testnet coin_type 1 under the eCurrency HKDF label.
      falconSeed: '6619df4ab5620c2689921715ee3628f8e856f9fed20ce759ab3a2f69a5f0f1cc57da869f63524fa4d810f0f794a27b8f',
      falconAddress: '2A4zqLHoc3GDW6QR1G7rLGfoeoDjLHB2WXPNRFeyuDYmArDoVoid',
    },
  }

  for (const network of NETWORKS) {
    describe(network, () => {
      it('encodes addresses under the profile magic and decodes them back', () => {
        const classical = addressFromPubkey(getPublicKey(PRIV), 'ecdsa', network)
        expect(classical).toBe(PINS[network].classical)
        expect(validateAddress(classical, network)).toBe(true)
        expect(decodeAddress(classical)).toMatchObject({ network, type: 'classical' })

        const pq = addressFromScripthash(new Uint8Array(32).fill(0xab), network)
        expect(pq).toBe(PINS[network].pqFromScripthash)
        expect(validateAddress(pq, network)).toBe(true)
        expect(decodeAddress(pq)).toMatchObject({ network, type: 'pq' })
        expect(toHex(decodeAddress(pq).scripthash)).toBe('ab'.repeat(32))
      })

      it('round-trips WIF under the profile version bytes', () => {
        const wif = encodeWif(PRIV, network)
        expect(wif).toBe(PINS[network].wif)
        expect(toHex(decodeWif(wif, network).payload)).toBe(toHex(PRIV))
      })

      it('stretches the PQ leaf to the frozen Falcon seed and keygens from it', async () => {
        // The HKDF stage re-derived independently: BIP-32 leaf at the PQ path
        // → HKDF-SHA256 under the profile label → 48-byte keygen seed.
        const child = derivePath(master(), nativePqPath(0, 0, network))
        const seed48 = hkdf(sha256, child.privateKey!, undefined, PROFILE.falconHdInfo, FALCON512_SEED_BYTES)
        expect(toHex(seed48)).toBe(PINS[network].falconSeed)

        const [fromSeed, derived] = await Promise.all([
          falcon512KeygenFromSeed(seed48),
          deriveFalconKeypair(master(), 0, 0, 0, network),
        ])
        expect(toHex(derived.publicKey)).toBe(toHex(fromSeed.publicKey))
        expect(addressFromPubkey(derived.publicKey, 'falcon512', network)).toBe(PINS[network].falconAddress)
      })
    })
  }

  it('derives the app-data key under the profile label', () => {
    expect(toHex(deriveAppDataKey(SEED))).toBe('c88718ab07103545c41d9f1de1ea2d76396fc7cb14d89c44f7b0665335cbb69c')
  })

  it('hashes signed messages under the profile magic', () => {
    // varint(26-byte magic) = 0x1a — never a valid tx_type, so a message
    // digest can't collide with a transaction sighash.
    expect(signedMessagePreimage('Hello, chain!')[0]).toBe(0x1a)
    expect(toHex(signedMessageDigest('Hello, chain!'))).toBe('a6c8e6ebf2cb0646fe4c70d19bb48698ff5239e77339177091aba95d82e4ba6d')
  })
})
