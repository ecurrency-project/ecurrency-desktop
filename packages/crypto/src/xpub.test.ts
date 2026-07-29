import { describe, expect, it } from 'vitest';
import { addressFromPubkey } from './address';
import { activeScheme, derivePath, nativePath, nativePathFor, masterKeyFromSeed, type DerivationScheme } from './bip32';
import type { Network } from './constants';
import { addressFromXpub, exportAccountXpub, exportAccountXpubFor, isValidAccountXpub, parseAccountXpub } from './xpub';

// A fixed (non-secret) seed — deterministic so the vectors below are stable.
const master = masterKeyFromSeed(Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff));

// The seed-derived address at a leaf, for cross-checking the xpub-derived one.
function seedAddress(chain: 0 | 1, index: number, network: Network): string {
  const node = derivePath(master, nativePath(0, index, network, chain));
  if (node.publicKey === null) throw new Error('derived node has no public key');
  return addressFromPubkey(node.publicKey, 'ecdsa', network);
}

describe('account xpub (classical watch-only)', () => {
  it('derives the same addresses as the seed, across both chains and indices', () => {
    const account = parseAccountXpub(exportAccountXpub(master, 'mainnet', 0));
    for (const chain of [0, 1] as const) {
      for (const index of [0, 1, 2, 7, 20]) {
        expect(addressFromXpub(account, chain, index, 'mainnet')).toBe(seedAddress(chain, index, 'mainnet'));
      }
    }
  });

  it('matches the seed on a testnet account too (its own coin_type branch)', () => {
    // The network selects the account BRANCH on export as well as the address
    // encoding, so a testnet watch descriptor must be built from a testnet
    // xpub — pairing a mainnet xpub with testnet leaves derives a different
    // key entirely (that mismatch is what a schemes-aware descriptor prevents).
    const account = parseAccountXpub(exportAccountXpub(master, 'testnet'));
    expect(addressFromXpub(account, 0, 0, 'testnet')).toBe(seedAddress(0, 0, 'testnet'));
  });

  it('renders one account key under either network prefix', () => {
    // Encoding-only: the same account node, two networks, two address forms.
    const account = parseAccountXpub(exportAccountXpub(master, 'mainnet'));
    expect(addressFromXpub(account, 0, 0, 'testnet')).not.toBe(addressFromXpub(account, 0, 0, 'mainnet'));
    expect(addressFromXpub(account, 0, 0, 'mainnet')).toBe(seedAddress(0, 0, 'mainnet'));
  });

  it('accepts a freshly exported account xpub', () => {
    expect(isValidAccountXpub(exportAccountXpub(master, 'mainnet', 0))).toBe(true);
    expect(isValidAccountXpub(exportAccountXpub(master, 'mainnet', 5))).toBe(true);
  });

  it('exportAccountXpubFor: active scheme matches the default export, another scheme differs but derives its own leaves', () => {
    const fake: DerivationScheme = {
      id: 'fake-v2',
      coinType: 7777,
      label: 'fake',
      status: 'legacy',
      pathTemplate: (account, change, index, _network) => `m/44'/7777'/${account}'/${change}/${index}`,
    };
    expect(exportAccountXpubFor(master, activeScheme(), 'mainnet', 0)).toBe(exportAccountXpub(master, 'mainnet', 0));
    const fakeXpub = exportAccountXpubFor(master, fake, 'mainnet', 0);
    expect(fakeXpub).not.toBe(exportAccountXpub(master, 'mainnet', 0));
    expect(isValidAccountXpub(fakeXpub)).toBe(true);
    // Public CKD from the scheme's account node reproduces the scheme's seed leaves.
    const node = derivePath(master, nativePathFor(fake, 0, 3, 'mainnet', 1));
    expect(addressFromXpub(parseAccountXpub(fakeXpub), 1, 3, 'mainnet')).toBe(
      addressFromPubkey(node.publicKey!, 'ecdsa', 'mainnet'),
    );
  });

  it('rejects junk, a master-depth xpub, and a private extended key', () => {
    expect(isValidAccountXpub('not an xpub')).toBe(false);
    expect(isValidAccountXpub('')).toBe(false);
    // The master's own xpub is depth 0 — not an account key.
    expect(isValidAccountXpub(master.publicExtendedKey)).toBe(false);
    // A private extended key at account depth must still be rejected.
    const accountPath = nativePath(0, 0, 'mainnet', 0).split('/').slice(0, 4).join('/');
    expect(isValidAccountXpub(derivePath(master, accountPath).privateExtendedKey)).toBe(false);
  });
});
