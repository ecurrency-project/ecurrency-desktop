import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileVaultStorage } from '../../src/main/vault/storage'

describe('FileVaultStorage', () => {
  it('reads null when empty, round-trips a write, and clears (idempotently)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qecr-vault-'))
    const storage = new FileVaultStorage(join(dir, 'nested', 'vault.json'))

    expect(await storage.read()).toBeNull()

    await storage.write('{"v":1,"blob":"ciphertext"}')
    expect(await storage.read()).toBe('{"v":1,"blob":"ciphertext"}')

    await storage.write('{"v":2}')
    expect(await storage.read()).toBe('{"v":2}')

    await storage.clear()
    expect(await storage.read()).toBeNull()
    await storage.clear() // idempotent on an already-empty store
  })
  it('retains the old ciphertext when cancelled before the rename and removes staging data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-restore-'))
    const file = join(dir, 'vault.json')
    const storage = new FileVaultStorage(file)
    await storage.write('old-ciphertext')
    let checks = 0
    await expect(storage.replace('new-ciphertext', () => {
      if (++checks === 3) throw new Error('Cancelled')
    })).rejects.toThrow('Cancelled')
    expect(await storage.read()).toBe('old-ciphertext')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })
})
