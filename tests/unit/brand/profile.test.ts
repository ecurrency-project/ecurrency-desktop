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
  META_V1_SCHEME_ID,
  nativePath,
  nativePqPath,
  sighashCommitsTokenId,
  signedMessageDigest,
  signedMessagePreimage,
  UPGRADE,
  validateAddress,
} from '../../../src/main/brand/crypto'
import { PROFILE } from '../../../src/main/brand/profile'

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
    expect(toHex(PROFILE.addrMagic.mainnet)).toBe('139d')
    expect(toHex(PROFILE.addrMagic.testnet)).toBe('047389')
    expect(PROFILE.wifVersion).toEqual({ mainnet: 0x80, testnet: 0xef })
    expect(PROFILE.addressRegex.mainnet.source).toBe('^(?:bq[1-9A-HJ-NP-Za-km-z]{33}|3u[H-K][1-9A-HJ-NP-Za-km-z]{49})$')
    expect(PROFILE.addressRegex.testnet.source).toBe('^(?:btq[1-9A-HJ-NP-Za-km-z]{33}|3ua[2-4][1-9A-HJ-NP-Za-km-z]{49})$')
  })

  it('pins the derivation schemes, ids and coin_types byte-exact', () => {
    expect(DERIVATION_SCHEMES.map((s) => [s.id, s.status])).toEqual([['qbt-v1-placeholder', 'active']])
    expect(activeScheme().id).toBe('qbt-v1-placeholder')
    expect(META_V1_SCHEME_ID).toBe('qbt-v1-placeholder')
    for (const network of NETWORKS) expect(coinTypeFor(activeScheme(), network)).toBe(1)
    expect(nativePath(0, 0, 'mainnet')).toBe("m/44'/1'/0'/0/0")
    expect(nativePath(1, 2, 'testnet', 1)).toBe("m/44'/1'/1'/1/2")
    expect(nativePqPath(0, 0, 'mainnet')).toBe("m/512'/1'/0'/0'/0'")
    expect(nativePqPath(1, 2, 'testnet', 1)).toBe("m/512'/1'/1'/1'/2'")
  })

  it('pins the HKDF labels and the signed-message magic', () => {
    expect(PROFILE.falconHdInfo).toBe('qbt/pq/falcon512/v1')
    expect(PROFILE.appDataInfo).toBe('qbt/app-data/v1')
    expect(PROFILE.messageMagic).toBe('QBitcoin Signed Message:\n')
  })

  it('has no conversion flow and commits the token id since genesis', () => {
    expect(UPGRADE).toBeNull()
    expect(DOWNGRADE).toBeNull()
    expect(PROFILE.tokenSighashFork).toEqual({ mainnet: 0, testnet: 0 })
    expect(sighashCommitsTokenId('mainnet', 0)).toBe(true)
    expect(sighashCommitsTokenId('testnet', 1)).toBe(true)
  })
})

describe('bound facade — goldens from the test mnemonic and the key 0x11…11', () => {
  const PINS: Record<
    Network,
    { classical: string; pqFromScripthash: string; wif: string; falconSeed: string; falconAddress: string }
  > = {
    mainnet: {
      classical: 'bqhMerNwWjSQcUzcQJKuvNE9rZV4iHS3rZd',
      pqFromScripthash: '3uJULrkN8zHk2thCUZ16qUH5gxmUC5qiPe2LYi57dyjX5y7P5KL8',
      wif: '5HwoXVkHoRM8sL2KmNRS217n1g8mPPBomrY7yehCuXC1115WWsh',
      falconSeed: 'b6dea86561688767533b3b5946927c774223ada26fdd10d8811876177c5cb569b1f0d37757a7fc07e4371afc91a56ff3',
      falconAddress: '3uJzZBGsAheR4MGjgL1JENwaTBGDbVxPCEKJvAZpmcshrsKBUsYM',
    },
    testnet: {
      classical: 'btqmvJWPpoj26LsmeuDGGo3PWdo3JXCtpt9Q',
      pqFromScripthash: '3ua3op5gua7tCsm7umHUtVKpawHVkomT3Cgvu6b7Pe2iYgqQAgz8u',
      wif: '91iS7EZqPeRGqPXcPiKLtbfjfLVUYYj17oQ54H3iFFw3n1UmZSS',
      // Same leaf as mainnet: the placeholder scheme uses coin_type 1 on both networks.
      falconSeed: 'b6dea86561688767533b3b5946927c774223ada26fdd10d8811876177c5cb569b1f0d37757a7fc07e4371afc91a56ff3',
      falconAddress: '3ua4L2QDQbqEsuDhSy4V5tEV5hVzWDBZi1HDsU3c6mfrjTjepWgBy',
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
    expect(toHex(deriveAppDataKey(SEED))).toBe('0809cd8f5fb580cc204124343208e0fb45b9b29a62080a568f4976c2bc565694')
  })

  it('hashes signed messages under the profile magic', () => {
    // varint(25-byte magic) = 0x19 — never a valid tx_type, so a message
    // digest can't collide with a transaction sighash.
    expect(signedMessagePreimage('Hello, chain!')[0]).toBe(0x19)
    expect(toHex(signedMessageDigest('Hello, chain!'))).toBe('de998dafe328aefb1c7605baf1817241aa4fe9d871a75aa8f7c73c9310a8eae3')
  })
})
