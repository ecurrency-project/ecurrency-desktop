// HD bookkeeping persisted at rest, sealed with a seed-derived key.
//
// The indices themselves aren't secret, but sealing them (via the Vault's
// app-data key) ties the metadata to this wallet's seed and keeps address-usage
// counts off disk in the clear. The blob store is the same string-file adapter
// the vault uses; the sealer is the Vault (available only while unlocked).

export interface WalletMeta {
  /** Next receive-chain index to hand out (classical / ECDSA branch). */
  readonly receiveIndex: number
  /** Next change-chain index to use (classical / ECDSA branch). */
  readonly changeIndex: number
  /** Next receive-chain index on the post-quantum (Falcon-512) branch. */
  readonly pqReceiveIndex: number
  /** Next change-chain index on the post-quantum (Falcon-512) branch. */
  readonly pqChangeIndex: number
}

export const DEFAULT_META: WalletMeta = { receiveIndex: 0, changeIndex: 0, pqReceiveIndex: 0, pqChangeIndex: 0 }

/** A string-blob store. The file storage adapter already matches this shape. */
export interface BlobStore {
  read(): Promise<string | null>
  write(blob: string): Promise<void>
}

/** Seal/open primitives — the Vault provides these when unlocked. */
export interface Sealer {
  sealData(plaintext: string): Promise<string>
  openData(blob: string): Promise<string>
}

export class WalletMetaStore {
  constructor(
    private readonly store: BlobStore,
    private readonly sealer: Sealer,
  ) {}

  /** Load the meta, or defaults when nothing has been written yet. */
  async load(): Promise<WalletMeta> {
    const blob = await this.store.read()
    if (blob === null) return DEFAULT_META
    const parsed = JSON.parse(await this.sealer.openData(blob)) as Partial<WalletMeta>
    return {
      receiveIndex: normIndex(parsed.receiveIndex),
      changeIndex: normIndex(parsed.changeIndex),
      pqReceiveIndex: normIndex(parsed.pqReceiveIndex),
      pqChangeIndex: normIndex(parsed.pqChangeIndex),
    }
  }

  async save(meta: WalletMeta): Promise<void> {
    await this.store.write(await this.sealer.sealData(JSON.stringify(meta)))
  }
}

function normIndex(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}
