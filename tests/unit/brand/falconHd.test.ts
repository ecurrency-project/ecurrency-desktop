import { hkdf } from '@noble/hashes/hkdf'
import { sha256 as nobleSha256 } from '@noble/hashes/sha256'
import { describe, expect, it } from 'vitest'
import {
  derivePath,
  FALCON512_PRIVATE_KEY_BYTES,
  FALCON512_PUBLIC_KEY_BYTES,
  falcon512Sign,
  falcon512Verify,
  masterKeyFromSeed,
  mnemonicToSeed,
  nativePqPathFor,
  PURPOSE_FALCON512,
  sha256,
  toHex,
  type DerivationScheme,
} from '@qbtc/crypto'
import { addressFromPubkey, decodeAddress, deriveFalconKeypair, nativePqPath } from '../../../src/main/brand/crypto'
import { PROFILE, SCHEME_ECR_PLACEHOLDER, SCHEME_ECR_V2 } from '../../../src/main/brand/profile'

// Golden-vector tests for the HD → Falcon-512 derivation (PQ branch) under
// the eCurrency profile.
//
// THESE VECTORS FREEZE THE SCHEMES. The mapping mnemonic → PQ address is
// consensus-for-recoverability: if any stage changes (path template,
// purpose, HKDF info label, seed length, keygen), existing PQ funds
// become unrecoverable from their mnemonic. A failure here is NOT a test
// to update — it's a derivation break to revert. Both schemes are
// frozen: v1 (999) holds shipped wallets' funds, v2 (8128) holds every
// wallet's funds from the migration on. Adding a v3 scheme is fine;
// changing v1 or v2 is not.

/** The standard BIP-39 test mnemonic. */
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function master() {
  return masterKeyFromSeed(mnemonicToSeed(MNEMONIC))
}

describe('nativePqPath', () => {
  it('builds the fully-hardened purpose-512 path on the active (v2) coin_type', () => {
    expect(PURPOSE_FALCON512).toBe(512)
    expect(nativePqPath(0, 0, 'mainnet')).toBe("m/512'/8128'/0'/0'/0'")
    expect(nativePqPath(0, 0, 'mainnet', 1)).toBe("m/512'/8128'/0'/1'/0'")
    expect(nativePqPath(1, 2, 'mainnet', 1)).toBe("m/512'/8128'/1'/1'/2'")
  })

  it('builds the v1 path via the explicit legacy scheme', () => {
    expect(nativePqPathFor(SCHEME_ECR_PLACEHOLDER, 0, 0, 'mainnet')).toBe("m/512'/999'/0'/0'/0'")
  })
})

const FAKE_SCHEME: DerivationScheme = {
  id: 'fake-v2',
  coinType: 7777,
  label: 'fake',
  status: 'legacy',
  pathTemplate: (account, change, index, _network) => `m/44'/7777'/${account}'/${change}/${index}`,
}

describe('nativePqPathFor / scheme-explicit derivation', () => {
  it("builds the PQ path on the EXPLICIT scheme's coin_type", () => {
    expect(nativePqPathFor(FAKE_SCHEME, 0, 0, 'mainnet')).toBe("m/512'/7777'/0'/0'/0'")
    expect(nativePqPathFor(FAKE_SCHEME, 1, 2, 'mainnet', 1)).toBe("m/512'/7777'/1'/1'/2'")
  })

  it('deriveFalconKeypair with an explicit scheme differs from the active one', async () => {
    const m = master()
    const active = await deriveFalconKeypair(m, 0, 0, 0, 'mainnet')
    const explicit = await deriveFalconKeypair(m, 0, 0, 0, 'mainnet', FAKE_SCHEME)
    expect(toHex(explicit.publicKey)).not.toBe(toHex(active.publicKey))
    // …and is deterministic on its own path.
    const again = await deriveFalconKeypair(m, 0, 0, 0, 'mainnet', FAKE_SCHEME)
    expect(toHex(again.publicKey)).toBe(toHex(explicit.publicKey))
  })

  it('the HKDF info label does not change with the scheme (versioned separately)', () => {
    // Same leaf, same label: reproduce the explicit-scheme keypair's seed input.
    const child = derivePath(master(), nativePqPathFor(FAKE_SCHEME, 0, 0, 'mainnet', 0))
    const seed48 = hkdf(nobleSha256, child.privateKey!, undefined, PROFILE.falconHdInfo, 48)
    expect(seed48.length).toBe(48)
  })
})

// One scheme's golden vectors: [account, change, index, sha256(publicKey),
// mainnet address], plus the frozen HKDF48 seed of leaf (0,0,0).
interface SchemeGoldens {
  readonly scheme: DerivationScheme
  readonly hkdf48: string
  readonly vectors: ReadonlyArray<[number, 0 | 1, number, string, string]>
}

const GOLDENS: readonly SchemeGoldens[] = [
  {
    // v1 (999): shipped wallets hold funds here — FROZEN FOREVER.
    scheme: SCHEME_ECR_PLACEHOLDER,
    hkdf48: '13b614ffb2b87be6187d9e0163938ee65e04bb9cb08350a37dee7e41f75983f4' + 'c87c87f242605818a775427e2be45031',
    vectors: [
      [0, 0, 0, '19900d30327887a8893a99168b355bfa9ddb1a50111f1cd8420a920edec39ce1', '26mLXtZ9j3aJx2K2CqM831JT4NQw1nzkYuVcgkTWbdByRMor2N5b'],
      [0, 0, 1, 'ba84237dec1ab31168d3721cf2b9571f689fe8d0289b3a94c4a741fdfa6f4929', '26mCNUPQRuFx7Hw66fbWSCaXegMPfnPoxfXmNRAqG9GkMDbdCVdL'],
      [0, 1, 0, '05f5a3bc4aa928b79a03823fdad55cd1e4532e05b23adaf72ca51309ae49a4b4', '26mEKFUCWhbexWGQSfnshp8EdPT1a5aFW1D8iiAq7CzPWkCq5aFr'],
      [1, 0, 0, '77de3e7f9f2954bc7be4577e774c02c9d3328e880b249d89ecf790150aaba4e5', '26mGfWfcVdYmQYVjn1QKMztNqiGT8srqhVVnDnFerzHkgkCkUeEo'],
    ],
  },
  {
    // v2 (8128, SLIP-0044): the active scheme — FROZEN from the migration on.
    // The HKDF48 seed matches the value precomputed independently in the
    // migration plan; the address vectors were captured from the WASM keygen
    // after cross-checking the pipeline against the v1 vectors above.
    scheme: SCHEME_ECR_V2,
    hkdf48: '0ff9de10602fbe7bc6c41bef89ef2d24a6bd98a1da7ca1cd99449ac3e562411f' + 'f59eaa1dd91cd286c999b593624709d5',
    vectors: [
      [0, 0, 0, '474d818895c684c73a3070547206ac9f26fa4e89c53906a37662477af56628d6', '26kn6raUwMh11AUUHaUX6wJCxwvdC84Yje5wtDfruzo12Rhm6fsr'],
      [0, 0, 1, 'cca3fb51cafdcb8d49b4fbf90f6c45e4e8469baa3751ce7738bf40b611c82bee', '26n8bDQCz7596P496U13Ev8f8Gkgc3kkNvuaVy39n6z11B66Xyhr'],
      [0, 1, 0, '502da8f1f2dd806c7612bafe4a87edd9a3deaaafa258d92edd8cb01d3536a0c8', '26ky6LW2AurG3sTQ8tAFqMpMncgNszerfucjzv8HD6Popw9wsdV1'],
      [1, 0, 0, 'dfd330bc7041f04af7102f36f1587876e80949d4a98b0202fd03e0fdd0c630e6', '26n2Aim2JUJEf8uaiXGweRAsrh79jgW7FjvVmXigh7JYcpSQCLNs'],
    ],
  },
]

describe.each(GOLDENS)('deriveFalconKeypair — golden vectors ($scheme.id, frozen)', ({ scheme, hkdf48, vectors }) => {
  it('HKDF stage: leaf(0,0,0) stretches to the frozen 48-byte seed', () => {
    // Pins path + info label + HKDF independently of the WASM keygen.
    const child = derivePath(master(), nativePqPathFor(scheme, 0, 0, 'mainnet', 0))
    const seed48 = hkdf(nobleSha256, child.privateKey!, undefined, PROFILE.falconHdInfo, 48)
    expect(PROFILE.falconHdInfo).toBe('ecr/pq/falcon512/v1')
    expect(toHex(seed48)).toBe(hkdf48)
  })

  it('maps the test mnemonic to the frozen pubkeys and addresses', async () => {
    const m = master()
    for (const [account, change, index, pkHash, address] of vectors) {
      const kp = await deriveFalconKeypair(m, account, change, index, 'mainnet', scheme)
      expect(kp.publicKey.length).toBe(FALCON512_PUBLIC_KEY_BYTES)
      expect(kp.privateKey.length).toBe(FALCON512_PRIVATE_KEY_BYTES)
      expect(kp.publicKey[0]).toBe(0x09) // Falcon-512 version byte
      expect(toHex(sha256(kp.publicKey))).toBe(pkHash)
      expect(addressFromPubkey(kp.publicKey, 'falcon512', 'mainnet')).toBe(address)
    }
  })

  it('derived addresses decode as the 32-byte PQ form', async () => {
    const kp = await deriveFalconKeypair(master(), 0, 0, 0, 'mainnet', scheme)
    const decoded = decodeAddress(addressFromPubkey(kp.publicKey, 'falcon512', 'mainnet'))
    expect(decoded.type).toBe('pq')
    expect(decoded.scripthash.length).toBe(32)
    expect(decoded.network).toBe('mainnet')
  })
})

describe('the active scheme is v2', () => {
  it('default derivation (no explicit scheme) equals explicit v2 derivation', async () => {
    const m = master()
    const byDefault = await deriveFalconKeypair(m, 0, 0, 0, 'mainnet')
    const explicit = await deriveFalconKeypair(m, 0, 0, 0, 'mainnet', SCHEME_ECR_V2)
    expect(toHex(byDefault.publicKey)).toBe(toHex(explicit.publicKey))
  })
})

describe('deriveFalconKeypair — properties', () => {
  it('is deterministic: same cell twice → identical keypair', async () => {
    const a = await deriveFalconKeypair(master(), 0, 0, 0, 'mainnet')
    const b = await deriveFalconKeypair(master(), 0, 0, 0, 'mainnet')
    expect(toHex(a.publicKey)).toBe(toHex(b.publicKey))
    expect(toHex(a.privateKey)).toBe(toHex(b.privateKey))
  })

  it('neighbouring cells (account/change/index) all differ', async () => {
    const m = master()
    const cells: Array<[number, 0 | 1, number]> = [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ]
    const pks = new Set<string>()
    for (const [a, c, i] of cells) {
      pks.add(toHex((await deriveFalconKeypair(m, a, c, i, 'mainnet')).publicKey))
    }
    expect(pks.size).toBe(cells.length)
  })

  it('the derived keypair signs and verifies', async () => {
    const kp = await deriveFalconKeypair(master(), 0, 0, 0, 'mainnet')
    const msg = new TextEncoder().encode('ecr pq phase-a')
    const sig = await falcon512Sign(msg, kp.privateKey)
    expect(sig.length).toBeGreaterThan(0)
    expect(await falcon512Verify(sig, msg, kp.publicKey)).toBe(true)
    // Wrong message must not verify.
    expect(await falcon512Verify(sig, new TextEncoder().encode('tampered'), kp.publicKey)).toBe(false)
  })
})
