import type { Algorithm } from '@qbtc/crypto'
import type { BlobStore, Sealer } from './meta'

// An imported single private key (WIF), sealed at rest with the app-data key —
// the same seed-derived key that seals imported seeds, watch sources and
// metadata. One sealed blob per key wallet, opened on demand for address
// derivation and signing.
//
// The WIF alone doesn't identify the algorithm (a 32-byte payload is valid for
// both ECDSA and Schnorr), so the user's choice is stored beside it. The
// address is derived data, persisted so the wallet list and duplicate checks
// can show it without re-running key derivation (Falcon needs WASM); the
// session re-derives it from the key and can therefore detect a stale blob.
//
// NOTE: like imported seeds, this seals under the PRIMARY wallet's app-data
// key — restoring the primary vault from a different phrase makes the blob
// unopenable. The import UI warns that the recovery phrase does NOT back up
// imported keys.
export interface StoredKey {
  /** The key exactly as imported (WIF string). */
  readonly wif: string
  /** Which algorithm the user imported it as (the WIF alone can't tell). */
  readonly algo: Algorithm
  /** The key's single address (derived at import; display + duplicate checks). */
  readonly address: string
}

// Sealed-at-rest store for one imported key (one per key wallet, under its dir).
export class KeyStore {
  // undefined = not loaded yet; null = loaded, none stored.
  private cache: StoredKey | null | undefined = undefined

  constructor(
    private readonly store: BlobStore,
    private readonly sealer: Sealer,
  ) {}

  async load(): Promise<StoredKey | null> {
    if (this.cache !== undefined) return this.cache
    const blob = await this.store.read()
    if (blob === null) {
      this.cache = null
      return null
    }
    this.cache = JSON.parse(await this.sealer.openData(blob)) as StoredKey
    return this.cache
  }

  async save(key: StoredKey): Promise<void> {
    this.cache = key
    await this.store.write(await this.sealer.sealData(JSON.stringify(key)))
  }

  // Drop the in-memory copy (on lock or wallet switch) without touching disk.
  reset(): void {
    this.cache = undefined
  }
}
