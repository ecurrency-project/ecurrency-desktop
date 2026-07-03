// Tests for the HD → Falcon-512 derivation (PQ branch).
//
// The mapping mnemonic → PQ address is consensus-for-recoverability: if
// any stage changes (path template, purpose, HKDF info label, seed
// length, keygen), existing PQ funds become unrecoverable from their
// mnemonic. Brand branches therefore pin FULL mnemonic → pubkey/address
// golden vectors in their own stacks once their scheme is final. The
// common base pins the HKDF stage against the CURRENT placeholder scheme
// (it moves when the QBitcoin coin_type lands — that's expected here,
// but must never happen on a shipped brand) plus scheme-independent
// structural properties.

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { describe, expect, it } from 'vitest';

import { addressFromPubkey, decodeAddress } from './address';
import { COIN_TYPE, derivePath, masterKeyFromSeed } from './bip32';
import { mnemonicToSeed } from './bip39';
import { toHex } from './encoding/hex';
import {
  FALCON512_PRIVATE_KEY_BYTES,
  FALCON512_PUBLIC_KEY_BYTES,
  falcon512Sign,
  falcon512Verify,
} from './falcon512';
import {
  FALCON_HD_INFO,
  PURPOSE_FALCON512,
  deriveFalconKeypair,
  nativePqPath,
} from './falconHd';
import { sha256 } from './hashes';

/** The standard BIP-39 test mnemonic (same one bip39.test.ts uses). */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function master() {
  return masterKeyFromSeed(mnemonicToSeed(MNEMONIC));
}

describe('nativePqPath', () => {
  it('builds the fully-hardened purpose-512 path on the active coin_type', () => {
    expect(PURPOSE_FALCON512).toBe(512);
    expect(nativePqPath(0, 0)).toBe(`m/512'/${COIN_TYPE}'/0'/0'/0'`);
    expect(nativePqPath(0, 0, 1)).toBe(`m/512'/${COIN_TYPE}'/0'/1'/0'`);
    expect(nativePqPath(1, 2, 1)).toBe(`m/512'/${COIN_TYPE}'/1'/1'/2'`);
  });
});

describe('deriveFalconKeypair — HKDF stage (placeholder scheme)', () => {
  it('HKDF stage: leaf(0,0,0) stretches to the pinned 48-byte seed', () => {
    // Pins path + info label + HKDF independently of the WASM keygen.
    // NOTE: pinned against the qbt-v1 PLACEHOLDER (coinType stand-in); it
    // moves when the real QBitcoin coin_type lands. Brand branches pin
    // their own frozen value plus full mnemonic → address vectors.
    const child = derivePath(master(), nativePqPath(0, 0, 0));
    const seed48 = hkdf(
      nobleSha256,
      child.privateKey!,
      undefined,
      FALCON_HD_INFO,
      48,
    );
    expect(FALCON_HD_INFO).toBe('qbt/pq/falcon512/v1');
    expect(toHex(seed48)).toBe(
      'b6dea86561688767533b3b5946927c774223ada26fdd10d8811876177c5cb569' +
        'b1f0d37757a7fc07e4371afc91a56ff3',
    );
  });

  it('derived keys have the Falcon-512 shape', async () => {
    const kp = await deriveFalconKeypair(master(), 0, 0, 0);
    expect(kp.publicKey.length).toBe(FALCON512_PUBLIC_KEY_BYTES);
    expect(kp.privateKey.length).toBe(FALCON512_PRIVATE_KEY_BYTES);
    expect(kp.publicKey[0]).toBe(0x09); // Falcon-512 version byte
    expect(toHex(sha256(kp.publicKey))).toHaveLength(64);
  });

  it('derived addresses decode as the 32-byte PQ form', async () => {
    const kp = await deriveFalconKeypair(master(), 0, 0, 0);
    const decoded = decodeAddress(
      addressFromPubkey(kp.publicKey, 'falcon512', 'mainnet'),
    );
    expect(decoded.type).toBe('pq');
    expect(decoded.scripthash.length).toBe(32);
    expect(decoded.network).toBe('mainnet');
  });
});

describe('deriveFalconKeypair — properties', () => {
  it('is deterministic: same cell twice → identical keypair', async () => {
    const a = await deriveFalconKeypair(master(), 0, 0, 0);
    const b = await deriveFalconKeypair(master(), 0, 0, 0);
    expect(toHex(a.publicKey)).toBe(toHex(b.publicKey));
    expect(toHex(a.privateKey)).toBe(toHex(b.privateKey));
  });

  it('neighbouring cells (account/change/index) all differ', async () => {
    const m = master();
    const cells: Array<[number, 0 | 1, number]> = [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ];
    const pks = new Set<string>();
    for (const [a, c, i] of cells) {
      pks.add(toHex((await deriveFalconKeypair(m, a, c, i)).publicKey));
    }
    expect(pks.size).toBe(cells.length);
  });

  it('the derived keypair signs and verifies', async () => {
    const kp = await deriveFalconKeypair(master(), 0, 0, 0);
    const msg = new TextEncoder().encode('pq phase-a');
    const sig = await falcon512Sign(msg, kp.privateKey);
    expect(sig.length).toBeGreaterThan(0);
    expect(await falcon512Verify(sig, msg, kp.publicKey)).toBe(true);
    // Wrong message must not verify.
    expect(
      await falcon512Verify(sig, new TextEncoder().encode('tampered'), kp.publicKey),
    ).toBe(false);
  });
});
