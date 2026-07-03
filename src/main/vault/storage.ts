import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { VaultStorage } from '@qbitcoin/vault'

// File-backed persistence for the encrypted vault blob. The blob handed to
// write() is already ciphertext (the Vault seals it with Argon2id + AES-GCM);
// this layer only moves bytes to and from a file under the app's userData dir.
// Writes are atomic (temp file + rename) and the file is owner-only (0600).
export class FileVaultStorage implements VaultStorage {
  constructor(private readonly file: string) {}

  async read(): Promise<string | null> {
    try {
      return await fs.readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async write(blob: string): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, blob, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, this.file)
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
