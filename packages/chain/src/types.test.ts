import { describe, expect, it } from 'vitest';
import { balanceOf, type AddressInfo } from './types';
import { DEFAULT_NODES, nodesFor } from './defaultNodes';

describe('balanceOf', () => {
  it('returns confirmed-only when mempool is zero', () => {
    const info: AddressInfo = {
      address: 'EC...',
      chain: {
        fundedTxCount: 1,
        fundedSum: 500_000_000n,
        spentTxCount: 0,
        spentSum: 0n,
      },
      mempool: {
        fundedTxCount: 0,
        fundedSum: 0n,
        spentTxCount: 0,
        spentSum: 0n,
      },
      tokens: {},
    };
    expect(balanceOf(info)).toBe(500_000_000n);
  });

  it('subtracts spent sums', () => {
    const info: AddressInfo = {
      address: 'EC...',
      chain: {
        fundedTxCount: 2,
        fundedSum: 500_000_000n,
        spentTxCount: 1,
        spentSum: 100_000_000n,
      },
      mempool: {
        fundedTxCount: 0,
        fundedSum: 0n,
        spentTxCount: 0,
        spentSum: 0n,
      },
      tokens: {},
    };
    expect(balanceOf(info)).toBe(400_000_000n);
  });

  it('includes mempool net delta', () => {
    const info: AddressInfo = {
      address: 'EC...',
      chain: {
        fundedTxCount: 1,
        fundedSum: 500_000_000n,
        spentTxCount: 0,
        spentSum: 0n,
      },
      mempool: {
        fundedTxCount: 1,
        fundedSum: 50_000_000n,
        spentTxCount: 1,
        spentSum: 200_000_000n,
      },
      tokens: {},
    };
    // confirmed 500M − 0 = +500M, mempool +50M − 200M = −150M
    // net = 350M
    expect(balanceOf(info)).toBe(350_000_000n);
  });

  it('clamps a rounding-negative total to zero', () => {
    // An emptied heavy-staking address: both cumulative sums came from
    // node-side doubles, and their difference can dip a hair below zero.
    const info: AddressInfo = {
      address: 'EC…',
      chain: { fundedTxCount: 751_820, fundedSum: 1_541_593_943_344_830_000_000n, spentTxCount: 751_820, spentSum: 1_541_593_943_344_830_262_144n },
      mempool: { fundedTxCount: 0, fundedSum: 0n, spentTxCount: 0, spentSum: 0n },
      tokens: {},
    };
    expect(balanceOf(info)).toBe(0n);
  });
});

describe('DEFAULT_NODES + nodesFor', () => {
  // The common base ships no default endpoints (brand branches add theirs
  // and restore an "at least one entry" assertion in their stacks).

  it('all default entries use HTTPS', () => {
    for (const node of DEFAULT_NODES) {
      expect(node.url.startsWith('https://')).toBe(true);
    }
  });

  it('nodesFor returns priority-sorted list', () => {
    const sorted = nodesFor('mainnet');
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.priority).toBeGreaterThanOrEqual(sorted[i - 1]!.priority);
    }
  });

  it('nodesFor filters by network', () => {
    for (const n of nodesFor('mainnet')) expect(n.network).toBe('mainnet');
    for (const n of nodesFor('testnet')) expect(n.network).toBe('testnet');
  });
});
