import type { BlobStore, Sealer } from './meta'
import type { DowngradeEpisodeRecord, DowngradeStore } from './DowngradeService'

// Persisted downgrade episodes, sealed like the other wallet metadata. Holds
// only which freeze outpoints are ours and how to derive their reclaim keys;
// the CHAIN is the source of truth for every episode's state. A lost blob is
// recoverable: freezes spend our own inputs, so they appear in our history,
// and the freeze-address UTXOs carry hash256 of our pubkeys in their data.

export class DowngradeMetaStore implements DowngradeStore {
  constructor(
    private readonly store: BlobStore,
    private readonly sealer: Sealer,
  ) {}

  async load(): Promise<readonly DowngradeEpisodeRecord[]> {
    const blob = await this.store.read()
    if (blob === null) return []
    const parsed = JSON.parse(await this.sealer.openData(blob)) as { episodes?: unknown }
    if (!Array.isArray(parsed.episodes)) return []
    // Tolerant read: malformed entries are dropped, not fatal.
    return parsed.episodes.filter((e: unknown): e is DowngradeEpisodeRecord => {
      if (typeof e !== 'object' || e === null) return false
      const r = e as Partial<DowngradeEpisodeRecord>
      return (
        typeof r.freezeTxid === 'string' &&
        typeof r.vout === 'number' &&
        typeof r.valueAtomic === 'string' &&
        typeof r.btcScriptPubKeyHex === 'string' &&
        typeof r.reclaim === 'object' &&
        r.reclaim !== null
      )
    })
  }

  async save(episodes: readonly DowngradeEpisodeRecord[]): Promise<void> {
    await this.store.write(await this.sealer.sealData(JSON.stringify({ episodes })))
  }
}
