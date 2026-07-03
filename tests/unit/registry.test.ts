import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WALLET_ID, migrateLegacyLayout, walletDir, WalletRegistry, type WalletEntry } from '../../src/main/vault/registry'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wallet-registry-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('migrateLegacyLayout', () => {
  it('moves legacy flat files into wallets/default and leaves the address book global', () => {
    writeFileSync(join(dir, 'vault.json'), 'VAULT')
    writeFileSync(join(dir, 'walletmeta.json'), 'META')
    writeFileSync(join(dir, 'snapshot.json'), 'SNAP')
    writeFileSync(join(dir, 'coinmeta.json'), 'COIN')
    writeFileSync(join(dir, 'txlabels.json'), 'LABELS')
    writeFileSync(join(dir, 'contacts.json'), 'CONTACTS')

    migrateLegacyLayout(dir)

    const d = walletDir(dir, DEFAULT_WALLET_ID)
    expect(readFileSync(join(d, 'vault.json'), 'utf8')).toBe('VAULT')
    expect(readFileSync(join(d, 'walletmeta.json'), 'utf8')).toBe('META')
    expect(readFileSync(join(d, 'snapshot.json'), 'utf8')).toBe('SNAP')
    expect(readFileSync(join(d, 'coinmeta.json'), 'utf8')).toBe('COIN')
    expect(readFileSync(join(d, 'txlabels.json'), 'utf8')).toBe('LABELS')
    // Moved, not copied — the legacy locations are gone…
    expect(existsSync(join(dir, 'vault.json'))).toBe(false)
    // …except the global address book, which stays put.
    expect(readFileSync(join(dir, 'contacts.json'), 'utf8')).toBe('CONTACTS')
    expect(existsSync(join(d, 'contacts.json'))).toBe(false)
  })

  it('is idempotent and never clobbers an already-migrated file', () => {
    const d = walletDir(dir, DEFAULT_WALLET_ID)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'vault.json'), 'NEW')
    writeFileSync(join(dir, 'vault.json'), 'OLD') // a stray legacy copy

    migrateLegacyLayout(dir)
    migrateLegacyLayout(dir) // running twice must still be safe

    // The already-present new file wins; the stray legacy copy is left untouched.
    expect(readFileSync(join(d, 'vault.json'), 'utf8')).toBe('NEW')
  })

  it('does nothing on a fresh install (no legacy files)', () => {
    migrateLegacyLayout(dir)
    expect(existsSync(walletDir(dir, DEFAULT_WALLET_ID))).toBe(false)
  })
})

describe('WalletRegistry', () => {
  it('creates and persists a default seed wallet on first load', () => {
    const file = join(dir, 'wallets.json')
    const reg = new WalletRegistry(file)

    expect(reg.getActiveId()).toBe(DEFAULT_WALLET_ID)
    expect(reg.get(DEFAULT_WALLET_ID)?.kind).toBe('seed')
    expect(reg.list()).toHaveLength(1)
    expect(existsSync(file)).toBe(true)
  })

  it('reads back a persisted registry without rewriting it', () => {
    const file = join(dir, 'wallets.json')
    new WalletRegistry(file)
    const onDisk = readFileSync(file, 'utf8')

    const reloaded = new WalletRegistry(file)
    expect(reloaded.getActiveId()).toBe(DEFAULT_WALLET_ID)
    expect(readFileSync(file, 'utf8')).toBe(onDisk)
  })

  it('falls back to a default registry when the index is corrupt', () => {
    const file = join(dir, 'wallets.json')
    writeFileSync(file, '{ not valid json')

    const reg = new WalletRegistry(file)
    expect(reg.getActiveId()).toBe(DEFAULT_WALLET_ID)
    expect(reg.list()).toHaveLength(1)
  })

  it('returns undefined for an unknown wallet id', () => {
    const reg = new WalletRegistry(join(dir, 'wallets.json'))
    expect(reg.get('nope')).toBeUndefined()
  })
})

describe('WalletRegistry mutations', () => {
  const open = (): WalletRegistry => new WalletRegistry(join(dir, 'wallets.json'))
  const watch = (id: string, label = id): WalletEntry => ({ id, kind: 'watch', label, createdAt: 1 })

  it('adds a wallet and persists it across a reload', () => {
    const reg = open()
    reg.add(watch('cold'))
    expect(reg.list().map((w) => w.id)).toEqual([DEFAULT_WALLET_ID, 'cold'])
    expect(open().get('cold')?.kind).toBe('watch')
  })

  it('rejects a duplicate id', () => {
    const reg = open()
    reg.add(watch('cold'))
    expect(() => reg.add(watch('cold'))).toThrow()
  })

  it('renames a wallet', () => {
    const reg = open()
    reg.add(watch('cold', 'Cold'))
    reg.rename('cold', 'Cold vault')
    expect(open().get('cold')?.label).toBe('Cold vault')
  })

  it('switches the active wallet', () => {
    const reg = open()
    reg.add(watch('cold'))
    reg.setActive('cold')
    expect(open().getActiveId()).toBe('cold')
  })

  it('removes a wallet, reassigning the active id when it was the one removed', () => {
    const reg = open()
    reg.add(watch('cold'))
    reg.setActive('cold')
    reg.remove('cold')
    expect(reg.list().map((w) => w.id)).toEqual([DEFAULT_WALLET_ID])
    expect(reg.getActiveId()).toBe(DEFAULT_WALLET_ID)
  })

  it('refuses to remove the only wallet, and rejects unknown ids', () => {
    const reg = open()
    expect(() => reg.remove(DEFAULT_WALLET_ID)).toThrow()
    expect(() => reg.setActive('nope')).toThrow()
    expect(() => reg.rename('nope', 'x')).toThrow()
  })
})
