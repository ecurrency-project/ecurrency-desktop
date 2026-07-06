import type { BlobStore, Sealer } from './meta'
import type { UpgradeStore } from './UpgradeService'

// Persisted staging cursor for the upgrade flow, sealed like the other
// wallet metadata. Deliberately tiny: the index isn't secret, but sealing
// keeps usage patterns off disk in the clear — and the CHAIN, not this
// blob, is the source of truth for episode status (restore R1).

interface UpgradeMeta {
  readonly stagingIndex: number
}

export class UpgradeMetaStore implements UpgradeStore {
  constructor(
    private readonly store: BlobStore,
    private readonly sealer: Sealer,
  ) {}

  async loadStagingIndex(): Promise<number> {
    const blob = await this.store.read()
    if (blob === null) return 0
    const parsed = JSON.parse(await this.sealer.openData(blob)) as Partial<UpgradeMeta>
    const index = parsed.stagingIndex
    return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : 0
  }

  async saveStagingIndex(index: number): Promise<void> {
    const meta: UpgradeMeta = { stagingIndex: index }
    await this.store.write(await this.sealer.sealData(JSON.stringify(meta)))
  }
}
