import { describe, expect, it } from 'vitest';
import {
  COIN_TYPE,
  DERIVATION_SCHEMES,
  SCHEME_QBT_PLACEHOLDER,
  activeScheme,
  derivePath,
  nativePath,
  legacySchemes,
  masterKeyFromSeed,
  schemeById,
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
});

describe('nativePath', () => {
  it('constructs the standard receive path under the active scheme', () => {
    expect(nativePath(0, 0)).toBe(`m/44'/${COIN_TYPE}'/0'/0/0`);
  });

  it('builds change path with change=1', () => {
    expect(nativePath(0, 5, 1)).toBe(`m/44'/${COIN_TYPE}'/0'/1/5`);
  });

  it('can be passed to derivePath', () => {
    const m = masterKeyFromSeed(TV1_SEED);
    const child = derivePath(m, nativePath(0, 0));
    expect(child.privateKey).toBeDefined();
    expect(child.privateKey!.length).toBe(32);
  });

  it('different indices give different keys', () => {
    const m = masterKeyFromSeed(TV1_SEED);
    const a = derivePath(m, nativePath(0, 0));
    const b = derivePath(m, nativePath(0, 1));
    expect(toHex(a.privateKey!)).not.toBe(toHex(b.privateKey!));
  });

  it('matches the active scheme pathTemplate output', () => {
    expect(nativePath(2, 7, 1)).toBe(
      SCHEME_QBT_PLACEHOLDER.pathTemplate(2, 1, 7),
    );
  });
});
