import { describe, expect, it } from 'vitest';
import {
  BrowserExtensionStorage,
  InMemoryVaultStorage,
  type BrowserStorageArea,
} from './storage';

describe('InMemoryVaultStorage', () => {
  it('starts empty', async () => {
    const s = new InMemoryVaultStorage();
    expect(await s.read()).toBeNull();
  });

  it('reads back what it wrote', async () => {
    const s = new InMemoryVaultStorage();
    await s.write('hello');
    expect(await s.read()).toBe('hello');
  });

  it('overwrites on second write', async () => {
    const s = new InMemoryVaultStorage();
    await s.write('first');
    await s.write('second');
    expect(await s.read()).toBe('second');
  });

  it('clear() makes it empty', async () => {
    const s = new InMemoryVaultStorage();
    await s.write('something');
    await s.clear();
    expect(await s.read()).toBeNull();
  });

  it('clear() on empty is a no-op', async () => {
    const s = new InMemoryVaultStorage();
    await s.clear();
    expect(await s.read()).toBeNull();
  });
});

describe('BrowserExtensionStorage', () => {
  function makeFakeArea(): BrowserStorageArea & { backing: Map<string, unknown> } {
    const backing = new Map<string, unknown>();
    return {
      backing,
      async get(keys) {
        const arr = Array.isArray(keys) ? keys : keys === null ? [...backing.keys()] : [keys];
        const out: { [key: string]: unknown } = {};
        for (const k of arr) if (backing.has(k)) out[k] = backing.get(k);
        return out;
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) backing.set(k, v);
      },
      async remove(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) backing.delete(k);
      },
    };
  }

  it('uses default key "qbt.vault"', async () => {
    const area = makeFakeArea();
    const s = new BrowserExtensionStorage(area);
    await s.write('blob');
    expect(area.backing.get('qbt.vault')).toBe('blob');
  });

  it('respects custom key', async () => {
    const area = makeFakeArea();
    const s = new BrowserExtensionStorage(area, 'my-vault');
    await s.write('blob');
    expect(area.backing.has('qbt.vault')).toBe(false);
    expect(area.backing.get('my-vault')).toBe('blob');
  });

  it('returns null when nothing stored', async () => {
    const area = makeFakeArea();
    const s = new BrowserExtensionStorage(area);
    expect(await s.read()).toBeNull();
  });

  it('round-trips', async () => {
    const s = new BrowserExtensionStorage(makeFakeArea());
    await s.write('payload');
    expect(await s.read()).toBe('payload');
  });

  it('returns null for non-string stored values (defensive)', async () => {
    const area = makeFakeArea();
    area.backing.set('qbt.vault', { not: 'a string' });
    const s = new BrowserExtensionStorage(area);
    expect(await s.read()).toBeNull();
  });

  it('clear() removes the entry', async () => {
    const area = makeFakeArea();
    const s = new BrowserExtensionStorage(area);
    await s.write('blob');
    await s.clear();
    expect(await s.read()).toBeNull();
    expect(area.backing.has('qbt.vault')).toBe(false);
  });
});
