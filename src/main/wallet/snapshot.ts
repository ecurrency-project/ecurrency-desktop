import type { WalletSnapshot } from '../../shared/protocol'
import type { BlobStore, Sealer } from './meta'

// The last-known read-model (balance, history, tokens), sealed at rest with the
// seed-derived key so unlock/restart can render instantly while fresh data loads in
// the background. It holds only the public display models — never keys or seed
// material — and even those are encrypted at rest and tied to this wallet's seed.
//
// A blob that can't be opened (e.g. a stale file left from a different seed, or
// corruption) is treated as absent, so it can never block or mislead startup.
export class SnapshotStore {
  private cache: WalletSnapshot | null = null
  private loaded = false
  // Writes are serialized through this chain: concurrent merges (a dashboard load
  // updates summary, history and tokens at once) would otherwise race on the
  // store's single temp file (tmp→final rename).
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: BlobStore,
    private readonly sealer: Sealer,
  ) {}

  async load(): Promise<WalletSnapshot | null> {
    if (this.loaded) return this.cache
    const blob = await this.store.read()
    if (blob !== null) {
      try {
        this.cache = JSON.parse(await this.sealer.openData(blob)) as WalletSnapshot
      } catch {
        this.cache = null
      }
    }
    this.loaded = true
    return this.cache
  }

  // Merge fresh pieces into the snapshot and persist. Each chain read updates its
  // own slice, so the file always carries the most recent of each. Serialized so
  // concurrent merges apply one after another rather than racing on the temp file.
  async merge(partial: WalletSnapshot): Promise<void> {
    const run = this.writeChain.then(async () => {
      const next: WalletSnapshot = { ...((await this.load()) ?? {}), ...partial }
      this.cache = next
      this.loaded = true
      await this.store.write(await this.sealer.sealData(JSON.stringify(next)))
    })
    // Keep the chain alive even if a write fails (snapshotting is best-effort).
    this.writeChain = run.catch(() => undefined)
    return run
  }

  /** Drop the in-memory copy (on lock); the sealed file persists for next unlock. */
  reset(): void {
    this.cache = null
    this.loaded = false
  }
}
