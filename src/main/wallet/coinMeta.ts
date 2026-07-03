import type { BlobStore, Sealer } from './meta'

/** Per-UTXO local metadata, keyed by `txid:vout`. */
export interface CoinMeta {
  readonly label?: string
  readonly frozen?: boolean
}

export type CoinMetaMap = Record<string, CoinMeta>

// Coin-control metadata (labels + freeze) sealed at rest with the seed-derived
// key — never leaves the device. Cached while unlocked; entries with neither a
// label nor a freeze flag are dropped so the map stays minimal.
export class CoinMetaStore {
  private cache: CoinMetaMap | null = null

  constructor(
    private readonly store: BlobStore,
    private readonly sealer: Sealer,
  ) {}

  async load(): Promise<CoinMetaMap> {
    if (this.cache !== null) return this.cache
    const blob = await this.store.read()
    this.cache = blob === null ? {} : (JSON.parse(await this.sealer.openData(blob)) as CoinMetaMap)
    return this.cache
  }

  async setLabel(outpoint: string, label: string): Promise<void> {
    const map = { ...(await this.load()) }
    const entry: { label?: string; frozen?: boolean } = { ...map[outpoint] }
    const trimmed = label.trim()
    if (trimmed === '') delete entry.label
    else entry.label = trimmed
    writeEntry(map, outpoint, entry)
    await this.persist(map)
  }

  async setFrozen(outpoint: string, frozen: boolean): Promise<void> {
    const map = { ...(await this.load()) }
    const entry: { label?: string; frozen?: boolean } = { ...map[outpoint] }
    if (frozen) entry.frozen = true
    else delete entry.frozen
    writeEntry(map, outpoint, entry)
    await this.persist(map)
  }

  /** Drop the cache (e.g. on lock/destroy) so the next read reloads from disk. */
  reset(): void {
    this.cache = null
  }

  private async persist(map: CoinMetaMap): Promise<void> {
    this.cache = map
    await this.store.write(await this.sealer.sealData(JSON.stringify(map)))
  }
}

function writeEntry(map: CoinMetaMap, outpoint: string, entry: CoinMeta): void {
  if (entry.label === undefined && entry.frozen === undefined) {
    delete map[outpoint]
  } else {
    map[outpoint] = entry
  }
}
