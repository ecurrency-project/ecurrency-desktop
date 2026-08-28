import { describe, expect, it } from 'vitest';
import {
  ADDR_MAGIC,
  ADDRESS_REGEX,
  ALGO_ID,
  ALGO_POSTQUANTUM_BIT,
  DENOMINATOR,
  SIGHASH,
  TOKEN_SIGHASH_FORK,
  WIF_VERSION,
  forkCommitsTokenId,
  isPostQuantum,
  sighashCommitsTokenId,
} from './constants';
import { toHex } from './encoding/hex';

describe('ADDR_MAGIC', () => {
  it('mainnet is 0x13 0x9d', () => {
    expect(toHex(ADDR_MAGIC.mainnet)).toBe('139d');
  });

  it('testnet is 0x04 0x73 0x89 (three bytes!)', () => {
    expect(toHex(ADDR_MAGIC.testnet)).toBe('047389');
    expect(ADDR_MAGIC.testnet.length).toBe(3);
  });
});

describe('WIF_VERSION', () => {
  it('mainnet matches Bitcoin (0x80)', () => {
    expect(WIF_VERSION.mainnet).toBe(0x80);
  });

  it('testnet matches Bitcoin testnet (0xEF)', () => {
    expect(WIF_VERSION.testnet).toBe(0xef);
  });
});

describe('ADDRESS_REGEX', () => {
  // Encoding-derived samples (base58check of magic ‖ scripthash ‖ checksum).
  it('mainnet matches classical bq… addresses', () => {
    expect(ADDRESS_REGEX.mainnet.test('bqcBXGDnSrGiiPVvqNXtyHboKj2oWKrLZWv')).toBe(true);
    expect(ADDRESS_REGEX.mainnet.test('bqSC4ijgCXhsjb9eikvex3pSUhcbWUmsSfU')).toBe(true);
  });

  it('mainnet rejects testnet-shaped addresses', () => {
    expect(ADDRESS_REGEX.mainnet.test('btq123456789012345678901234567890123456')).toBe(false);
  });

  it('rejects too-short / too-long', () => {
    expect(ADDRESS_REGEX.mainnet.test('bq')).toBe(false);
    expect(ADDRESS_REGEX.mainnet.test('bq' + 'a'.repeat(100))).toBe(false);
  });

  it('rejects gibberish', () => {
    expect(ADDRESS_REGEX.mainnet.test('not an address')).toBe(false);
  });

  // PQ third-char classes are the exact reachable base58 ranges for the
  // magic ‖ 32-byte hash ‖ checksum payload; see constants.ts.
  it('mainnet PQ class covers the reachable 3uH–3uK range', () => {
    const tail = '1'.repeat(49);
    expect(ADDRESS_REGEX.mainnet.test(`3uH${tail}`)).toBe(true);
    expect(ADDRESS_REGEX.mainnet.test(`3uJ${tail}`)).toBe(true);
    expect(ADDRESS_REGEX.mainnet.test(`3uK${tail}`)).toBe(true);
    expect(ADDRESS_REGEX.mainnet.test(`3uL${tail}`)).toBe(false); // unreachable
    expect(ADDRESS_REGEX.mainnet.test(`3uG${tail}`)).toBe(false); // unreachable
  });

  it('testnet PQ class covers the reachable 3ua2–3ua4 range', () => {
    const tail = '1'.repeat(49);
    expect(ADDRESS_REGEX.testnet.test(`3ua2${tail}`)).toBe(true);
    expect(ADDRESS_REGEX.testnet.test(`3ua3${tail}`)).toBe(true);
    expect(ADDRESS_REGEX.testnet.test(`3ua4${tail}`)).toBe(true);
    expect(ADDRESS_REGEX.testnet.test(`3ua5${tail}`)).toBe(false); // unreachable
    expect(ADDRESS_REGEX.testnet.test(`3ua1${tail}`)).toBe(false); // unreachable
  });
});

describe('ALGO_ID', () => {
  it('matches the node CRYPT_ALGO_* constants', () => {
    expect(ALGO_ID.ecdsa).toBe(1);
    expect(ALGO_ID.schnorr).toBe(2);
    expect(ALGO_ID.falcon512).toBe(129);
  });

  it('Falcon has the post-quantum bit set', () => {
    expect(ALGO_ID.falcon512 & ALGO_POSTQUANTUM_BIT).toBe(ALGO_POSTQUANTUM_BIT);
  });
});

describe('isPostQuantum', () => {
  it('ECDSA is classical', () => {
    expect(isPostQuantum('ecdsa')).toBe(false);
  });
  it('Schnorr is classical', () => {
    expect(isPostQuantum('schnorr')).toBe(false);
  });
  it('Falcon-512 is post-quantum', () => {
    expect(isPostQuantum('falcon512')).toBe(true);
  });
});

describe('DENOMINATOR', () => {
  it('is 10^8', () => {
    expect(DENOMINATOR).toBe(100_000_000);
  });
});

describe('SIGHASH', () => {
  it('values match the node', () => {
    expect(SIGHASH.ALL).toBe(1);
    expect(SIGHASH.NONE).toBe(2);
    expect(SIGHASH.SINGLE).toBe(3);
    expect(SIGHASH.ANYONECANPAY).toBe(0x80);
  });
});

describe('token sighash fork', () => {
  it('the predicate: null never commits, 0 always, T from T inclusive', () => {
    expect(forkCommitsTokenId(null, 0)).toBe(false);
    expect(forkCommitsTokenId(null, 4_000_000_000)).toBe(false);
    expect(forkCommitsTokenId(0, 0)).toBe(true);
    expect(forkCommitsTokenId(0, 1)).toBe(true);
    const fork = 1_789_430_400;
    expect(forkCommitsTokenId(fork, fork - 1)).toBe(false);
    expect(forkCommitsTokenId(fork, fork)).toBe(true);
    expect(forkCommitsTokenId(fork, fork + 1)).toBe(true);
  });

  it('sighashCommitsTokenId reads this build\'s fork times', () => {
    // Value-agnostic: brand branches pin the actual times in their own
    // brand tests; here only the wiring is under test.
    for (const network of ['mainnet', 'testnet'] as const) {
      const fork = TOKEN_SIGHASH_FORK[network];
      if (fork === null) {
        expect(sighashCommitsTokenId(network)).toBe(false);
      } else {
        expect(sighashCommitsTokenId(network, fork)).toBe(true);
        expect(sighashCommitsTokenId(network, Math.max(0, fork - 1))).toBe(fork === 0);
      }
    }
  });
});
