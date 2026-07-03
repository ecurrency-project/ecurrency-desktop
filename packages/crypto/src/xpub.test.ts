import { describe, expect, it } from 'vitest';
import { addressFromPubkey } from './address';
import { derivePath, nativePath, masterKeyFromSeed } from './bip32';
import type { Network } from './constants';
import { addressFromXpub, exportAccountXpub, isValidAccountXpub, parseAccountXpub } from './xpub';

// A fixed (non-secret) seed — deterministic so the vectors below are stable.
const master = masterKeyFromSeed(Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff));

// The seed-derived address at a leaf, for cross-checking the xpub-derived one.
function seedAddress(chain: 0 | 1, index: number, network: Network): string {
  const node = derivePath(master, nativePath(0, index, chain));
  if (node.publicKey === null) throw new Error('derived node has no public key');
  return addressFromPubkey(node.publicKey, 'ecdsa', network);
}

describe('account xpub (classical watch-only)', () => {
  it('derives the same addresses as the seed, across both chains and indices', () => {
    const account = parseAccountXpub(exportAccountXpub(master, 0));
    for (const chain of [0, 1] as const) {
      for (const index of [0, 1, 2, 7, 20]) {
        expect(addressFromXpub(account, chain, index, 'mainnet')).toBe(seedAddress(chain, index, 'mainnet'));
      }
    }
  });

  it('applies the requested network to xpub-derived addresses', () => {
    const account = parseAccountXpub(exportAccountXpub(master));
    expect(addressFromXpub(account, 0, 0, 'testnet')).toBe(seedAddress(0, 0, 'testnet'));
    expect(addressFromXpub(account, 0, 0, 'testnet')).not.toBe(seedAddress(0, 0, 'mainnet'));
  });

  it('accepts a freshly exported account xpub', () => {
    expect(isValidAccountXpub(exportAccountXpub(master, 0))).toBe(true);
    expect(isValidAccountXpub(exportAccountXpub(master, 5))).toBe(true);
  });

  it('rejects junk, a master-depth xpub, and a private extended key', () => {
    expect(isValidAccountXpub('not an xpub')).toBe(false);
    expect(isValidAccountXpub('')).toBe(false);
    // The master's own xpub is depth 0 — not an account key.
    expect(isValidAccountXpub(master.publicExtendedKey)).toBe(false);
    // A private extended key at account depth must still be rejected.
    const accountPath = nativePath(0, 0, 0).split('/').slice(0, 4).join('/');
    expect(isValidAccountXpub(derivePath(master, accountPath).privateExtendedKey)).toBe(false);
  });
});
