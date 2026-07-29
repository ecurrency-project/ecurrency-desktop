import { describe, expect, it } from 'vitest';
import {
  coinTypeFor,
  DERIVATION_SCHEMES,
  META_V1_SCHEME_ID,
  SCHEME_QBT_PLACEHOLDER,
  activeScheme,
  derivePath,
  nativePath,
  nativePathFor,
  legacySchemes,
  masterKeyFromSeed,
  requireScheme,
  schemeById,
  type DerivationScheme,
} from './bip32';
import { fromHex, toHex } from './encoding/hex';

// BIP-32 official test vectors from the spec:
// https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki#test-vectors
//
// Test Vector 1 — seed and chain master key.

const TV1_SEED = fromHex('000102030405060708090a0b0c0d0e0f');

// Expected master private-key bytes (32 bytes) and chain code (32 bytes)
// per BIP-32 spec Test Vector 1, derived from the seed above.
const TV1_MASTER_PRIV =
  'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35';
const TV1_MASTER_CC =
  '873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508';

// m/0' — first hardened child.
const TV1_0H_PRIV =
  'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea';

describe('masterKeyFromSeed — BIP-32 Test Vector 1', () => {
  it('produces correct master private key', () => {
    const m = masterKeyFromSeed(TV1_SEED);
    expect(toHex(m.privateKey!)).toBe(TV1_MASTER_PRIV);
  });

  it('produces correct master chain code', () => {
    const m = masterKeyFromSeed(TV1_SEED);
    expect(toHex(m.chainCode!)).toBe(TV1_MASTER_CC);
  });

  it('has 33-byte compressed public key', () => {
    const m = masterKeyFromSeed(TV1_SEED);
    expect(m.publicKey!.length).toBe(33);
  });
});

describe('derivePath — BIP-32 Test Vector 1', () => {
  it("matches expected key at m/0'", () => {
    const m = masterKeyFromSeed(TV1_SEED);
    const child = derivePath(m, "m/0'");
    expect(toHex(child.privateKey!)).toBe(TV1_0H_PRIV);
  });

  it('derives along a longer path without throwing', () => {
    const m = masterKeyFromSeed(TV1_SEED);
    const child = derivePath(m, "m/0'/1/2'/2/1000000000");
    expect(child.privateKey!.length).toBe(32);
    expect(child.chainCode!.length).toBe(32);
  });

  it('produces deterministic outputs for the same path', () => {
    const m1 = masterKeyFromSeed(TV1_SEED);
    const m2 = masterKeyFromSeed(TV1_SEED);
    expect(toHex(derivePath(m1, "m/0'/0/0").privateKey!)).toBe(
      toHex(derivePath(m2, "m/0'/0/0").privateKey!),
    );
  });
});

describe('derivation scheme registry', () => {
  it('has exactly one active scheme (invariant)', () => {
    const actives = DERIVATION_SCHEMES.filter((s) => s.status === 'active');
    expect(actives.length).toBe(1);
  });

  it('activeScheme() returns the placeholder', () => {
    expect(activeScheme().id).toBe('qbt-v1-placeholder');
    expect(activeScheme().coinType).toBe(1);
  });

  it('exposes the placeholder via SCHEME_QBT_PLACEHOLDER', () => {
    expect(SCHEME_QBT_PLACEHOLDER.id).toBe('qbt-v1-placeholder');
    expect(SCHEME_QBT_PLACEHOLDER.coinType).toBe(1);
    expect(SCHEME_QBT_PLACEHOLDER.status).toBe('active');
  });

  it('legacySchemes() is empty', () => {
    expect(legacySchemes()).toEqual([]);
  });

  it('schemeById finds the placeholder', () => {
    expect(schemeById('qbt-v1-placeholder')?.coinType).toBe(1);
  });

  it('schemeById returns undefined for unknown ids', () => {
    expect(schemeById('qbt-v2-official')).toBeUndefined();
  });

  it('requireScheme returns known schemes and throws on unknown ids', () => {
    expect(requireScheme('qbt-v1-placeholder')).toBe(SCHEME_QBT_PLACEHOLDER);
    expect(() => requireScheme('nope')).toThrow(/Unknown derivation scheme/);
  });

  // The original scheme must stay in the registry FOREVER, id byte-exact:
  // its id is persisted in wallet storage (meta, watch descriptors, UTXO
  // tags) and its paths hold user funds. Removing or renaming it would make
  // those funds invisible. When a real coin_type lands, it flips to
  // 'legacy' — it never leaves.
  it('keeps the v1 scheme registered forever, id byte-exact', () => {
    const v1 = DERIVATION_SCHEMES.find((s) => s.id === 'qbt-v1-placeholder');
    expect(v1).toBeDefined();
    expect(v1!.coinType).toBe(1);
    // Path shape frozen — coin_type level must match the scheme's coinType.
    expect(v1!.pathTemplate(0, 0, 0, 'mainnet')).toBe("m/44'/1'/0'/0/0");
    expect(v1!.pathTemplate(0, 0, 0, 'testnet')).toBe("m/44'/1'/0'/0/0");
  });

  it('lists the active scheme first (scan priority, primary branch pickers)', () => {
    expect(DERIVATION_SCHEMES[0]!.status).toBe('active');
  });

  it('has unique scheme ids', () => {
    const ids = DERIVATION_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('META_V1_SCHEME_ID names a registered scheme (owner of pre-v2 blobs)', () => {
    expect(schemeById(META_V1_SCHEME_ID)).toBeDefined();
    expect(META_V1_SCHEME_ID).toBe('qbt-v1-placeholder');
  });
});

describe('nativePathFor', () => {
  const fake: DerivationScheme = {
    id: 'fake-v2',
    coinType: 7777,
    label: 'fake',
    status: 'legacy',
    pathTemplate: (account, change, index, _network) => `m/44'/7777'/${account}'/${change}/${index}`,
  };

  it('builds the path from the EXPLICIT scheme, not the active one', () => {
    expect(nativePathFor(fake, 0, 3, 'mainnet', 1)).toBe("m/44'/7777'/0'/1/3");
    expect(nativePathFor(fake, 0, 3, 'mainnet', 1)).not.toBe(nativePath(0, 3, 'mainnet', 1));
  });

  it('matches nativePath when given the active scheme', () => {
    expect(nativePathFor(activeScheme(), 2, 7, 'mainnet', 1)).toBe(nativePath(2, 7, 'mainnet', 1));
  });
});

describe('nativePath', () => {
  // The active scheme's mainnet coin_type, resolved the way derivation does.
  const CT = coinTypeFor(activeScheme(), 'mainnet');

  it('constructs the standard receive path under the active scheme', () => {
    expect(nativePath(0, 0, 'mainnet')).toBe(`m/44'/${CT}'/0'/0/0`);
  });

  it('builds change path with change=1', () => {
    expect(nativePath(0, 5, 'mainnet', 1)).toBe(`m/44'/${CT}'/0'/1/5`);
  });

  it('can be passed to derivePath', () => {
    const m = masterKeyFromSeed(TV1_SEED);
    const child = derivePath(m, nativePath(0, 0, 'mainnet'));
    expect(child.privateKey).toBeDefined();
    expect(child.privateKey!.length).toBe(32);
  });

  it('different indices give different keys', () => {
    const m = masterKeyFromSeed(TV1_SEED);
    const a = derivePath(m, nativePath(0, 0, 'mainnet'));
    const b = derivePath(m, nativePath(0, 1, 'mainnet'));
    expect(toHex(a.privateKey!)).not.toBe(toHex(b.privateKey!));
  });

  it('matches the active scheme pathTemplate output', () => {
    expect(nativePath(2, 7, 'mainnet', 1)).toBe(
      SCHEME_QBT_PLACEHOLDER.pathTemplate(2, 1, 7, 'mainnet'),
    );
  });
});

describe('coinTypeFor — per-network coin_type', () => {
  // A scheme following the BIP-44 convention: the chain's registered number
  // on mainnet, the shared testnet coin_type 1 on testnet. Brand branches
  // use exactly this shape; the registry on the base stays single-numbered.
  const dual: DerivationScheme = {
    id: 'fake-dual',
    coinType: { mainnet: 2009, testnet: 1 },
    label: 'fake dual',
    status: 'legacy',
    pathTemplate: (account, change, index, network) =>
      `m/44'/${coinTypeFor(dual, network)}'/${account}'/${change}/${index}`,
  };

  it('a plain number applies to every network', () => {
    expect(coinTypeFor(SCHEME_QBT_PLACEHOLDER, 'mainnet')).toBe(1);
    expect(coinTypeFor(SCHEME_QBT_PLACEHOLDER, 'testnet')).toBe(1);
  });

  it('a record resolves per network, and the path follows it', () => {
    expect(coinTypeFor(dual, 'mainnet')).toBe(2009);
    expect(coinTypeFor(dual, 'testnet')).toBe(1);
    expect(nativePathFor(dual, 0, 0, 'mainnet')).toBe("m/44'/2009'/0'/0/0");
    expect(nativePathFor(dual, 0, 0, 'testnet')).toBe("m/44'/1'/0'/0/0");
    expect(nativePathFor(dual, 1, 3, 'mainnet', 1)).toBe("m/44'/2009'/1'/1/3");
  });
});
