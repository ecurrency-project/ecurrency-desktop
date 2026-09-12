// HD bookkeeping persisted at rest, sealed with a seed-derived key.
//
// The indices themselves aren't secret, but sealing them (via the Vault's
// app-data key) ties the metadata to this wallet's seed and keeps address-usage
// counts off disk in the clear. The blob store is the same string-file adapter
// the vault uses; the sealer is the Vault (available only while unlocked).
//
// Version 2 keys the indices BY DERIVATION SCHEME: when the chain gets its
// official SLIP-0044 coin_type, a second scheme joins the registry and each
// scheme keeps its own issued-index floors. A version-1 blob (flat indices,
// written when the wallet only had one scheme) is migrated on load — its
// indices belong to the scheme that was active at write time
// (META_V1_SCHEME_ID); every other scheme starts at zero.

import { META_V1_SCHEME_ID } from '../brand/crypto'

/** Issued-index floors for one derivation scheme's four HD chains. */
export interface SchemeIndices {
  /** Next receive-chain index to hand out (classical / ECDSA branch). */
  readonly receiveIndex: number
  /** Next change-chain index to use (classical / ECDSA branch). */
  readonly changeIndex: number
  /** Next receive-chain index on the post-quantum (Falcon-512) branch. */
  readonly pqReceiveIndex: number
  /** Next change-chain index on the post-quantum (Falcon-512) branch. */
  readonly pqChangeIndex: number
}

export const ZERO_INDICES: SchemeIndices = { receiveIndex: 0, changeIndex: 0, pqReceiveIndex: 0, pqChangeIndex: 0 }

export interface WalletMeta {
  readonly version: 2
  /** Per-scheme issued-index floors, keyed by the scheme's stable id. A scheme
   *  absent from the map simply hasn't issued anything yet (all zeros). */
  readonly schemes: Readonly<Record<string, SchemeIndices>>
}

export const DEFAULT_META: WalletMeta = { version: 2, schemes: {} }

/** The floors for `schemeId`, defaulting to all-zero for an untouched scheme. */
export function indicesFor(meta: WalletMeta, schemeId: string): SchemeIndices {
  return meta.schemes[schemeId] ?? ZERO_INDICES
}

/** A copy of `meta` with `schemeId`'s floors replaced by `indices`. */
export function withIndices(meta: WalletMeta, schemeId: string, indices: SchemeIndices): WalletMeta {
  return { version: 2, schemes: { ...meta.schemes, [schemeId]: indices } }
}

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
    // Which scheme owns a version-1 (flat) blob's indices. Injectable for
    // tests; real callers keep the registry's constant.
    private readonly v1SchemeId: string = META_V1_SCHEME_ID,
  ) {}

  /** Load the meta (migrating a v1 blob), or defaults when nothing is written yet. */
  async load(): Promise<WalletMeta> {
    const blob = await this.store.read()
    if (blob === null) return DEFAULT_META
    const parsed = JSON.parse(await this.sealer.openData(blob)) as Record<string, unknown>
    if (typeof parsed.schemes === 'object' && parsed.schemes !== null) {
      const schemes: Record<string, SchemeIndices> = {}
      for (const [id, value] of Object.entries(parsed.schemes as Record<string, unknown>)) {
        schemes[id] = normIndices(value)
      }
      return { version: 2, schemes }
    }
    // Version-1 blob: flat indices, written when the wallet had a single scheme.
    // They belong to the scheme that was active back then; others start fresh.
    return { version: 2, schemes: { [this.v1SchemeId]: normIndices(parsed) } }
  }

  async save(meta: WalletMeta): Promise<void> {
    await this.store.write(await this.sealer.sealData(JSON.stringify(meta)))
  }
}

function normIndices(value: unknown): SchemeIndices {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<SchemeIndices>
  return {
    receiveIndex: normIndex(v.receiveIndex),
    changeIndex: normIndex(v.changeIndex),
    pqReceiveIndex: normIndex(v.pqReceiveIndex),
    pqChangeIndex: normIndex(v.pqChangeIndex),
  }
}

function normIndex(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}
