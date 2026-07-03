import type { BlobStore, Sealer } from './meta'

// An imported seed wallet's recovery phrase, sealed at rest with the app-data key —
// the primary Vault's seed-derived key, the same one that seals watch sources and
// metadata. This is how a second (non-primary) seed is stored: one sealed blob per seed
// wallet, opened on demand to derive its master key for signing.
//
// The primary ('default') wallet keeps its own Vault (vault.json, password-encrypted)
// and never uses this — only additional imported seeds do. Because the app-data key is
// derived from the primary seed (not the password), a password change does not require
// re-sealing these blobs.
export interface StoredSeed {
  readonly mnemonic: string
  /** Optional BIP-39 passphrase ("25th word"); affects key derivation. */
  readonly passphrase?: string
}

// Sealed-at-rest store for one seed wallet's phrase (one per wallet, under its dir).
export class SeedStore {
  // undefined = not loaded yet; null = loaded, none stored.
  private cache: StoredSeed | null | undefined = undefined

  constructor(
    private readonly store: BlobStore,
    private readonly sealer: Sealer,
  ) {}

  async load(): Promise<StoredSeed | null> {
    if (this.cache !== undefined) return this.cache
    const blob = await this.store.read()
    if (blob === null) {
      this.cache = null
      return null
    }
    this.cache = JSON.parse(await this.sealer.openData(blob)) as StoredSeed
    return this.cache
  }

  async save(seed: StoredSeed): Promise<void> {
    this.cache = seed
    await this.store.write(await this.sealer.sealData(JSON.stringify(seed)))
  }

  // Drop the in-memory copy (on lock or wallet switch) without touching disk.
  reset(): void {
    this.cache = undefined
  }
}
