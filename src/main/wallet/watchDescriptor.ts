import {
  DERIVATION_SCHEMES,
  decodeAddress,
  exportAccountXpubFor,
  isValidAccountXpub,
  META_V1_SCHEME_ID,
  validateAddress,
  type HDKey,
  type Network,
} from '@qbitcoin/crypto'
import { deriveFalconAddress } from './addresses'
import { indicesFor, type WalletMeta } from './meta'

// A portable, key-free description of a wallet to watch, carried between machines as
// a single JSON token. Per derivation scheme it pairs the classical account xpub
// (public CKD reproduces every classical address) with an explicit list of Falcon
// addresses — the PQ branch is fully hardened and has no xpub, so a watcher can only
// see the addresses the source wallet derived and exported. After generating more PQ
// addresses on the source wallet, re-export to extend the watched range.
//
// Version history:
//  - v1: a single implicit scheme (the one active at export time) — one xpub,
//    one Falcon section. Still accepted forever; treated as the pre-multi-scheme
//    scheme's branches only (META_V1_SCHEME_ID).
//  - v2: one section PER derivation scheme (active scheme first), so a watcher
//    also sees legacy-scheme branches after a coin_type migration. Unknown
//    scheme ids are accepted — scanning needs no scheme knowledge, and a
//    descriptor may come from a newer wallet.

// BRAND VALUE: the kind tag is persisted inside exported descriptors, so a
// brand must never change it once shipped (existing exports would stop
// importing). Brand branches set their own tag.
export const WATCH_DESCRIPTOR_KIND = 'qbt-watch'
/** The version new exports are written at. Both versions are accepted on import. */
export const WATCH_DESCRIPTOR_VERSION = 2

// Indices to include beyond the issued PQ index when exporting the Falcon list, so a
// watcher sees a few not-yet-issued addresses (mirrors classical gap limits: 20/6).
export const FALCON_EXPORT_LOOKAHEAD = { receive: 20, change: 6 } as const

/** One derivation scheme's watchable material. */
export interface WatchDescriptorScheme {
  /** Stable id of the derivation scheme (see the crypto scheme registry). */
  readonly scheme: string
  /** Account-level xpub for the classical (secp256k1) branch of this scheme. */
  readonly classicalXpub: string
  /** Explicit Falcon addresses by chain; array position = derivation index. */
  readonly falcon: {
    readonly receive: readonly string[]
    readonly change: readonly string[]
  }
}

/** The original single-scheme layout. Never emitted anymore, accepted forever. */
export interface WatchDescriptorV1 {
  readonly kind: typeof WATCH_DESCRIPTOR_KIND
  readonly version: 1
  readonly network: Network
  readonly label?: string
  readonly classicalXpub: string
  readonly falcon: {
    readonly receive: readonly string[]
    readonly change: readonly string[]
  }
}

/** The multi-scheme layout (active scheme first). */
export interface WatchDescriptorV2 {
  readonly kind: typeof WATCH_DESCRIPTOR_KIND
  readonly version: 2
  readonly network: Network
  readonly label?: string
  readonly schemes: readonly WatchDescriptorScheme[]
}

export type WatchDescriptor = WatchDescriptorV1 | WatchDescriptorV2

/**
 * The per-scheme sections of a descriptor, version-normalized: a v1 descriptor
 * is exactly its pre-multi-scheme scheme's single section. Every consumer
 * (address source, display address) goes through this instead of sniffing
 * the version itself.
 */
export function descriptorSchemes(descriptor: WatchDescriptor): readonly WatchDescriptorScheme[] {
  if (descriptor.version === 2) return descriptor.schemes
  return [{ scheme: META_V1_SCHEME_ID, classicalXpub: descriptor.classicalXpub, falcon: descriptor.falcon }]
}

// ── Export: build a descriptor from the active seed wallet ──────────────────────

/** Everything needed to export one scheme's section. */
export interface BuildWatchDescriptorSchemeInput {
  /** The scheme's stable id, recorded verbatim in the descriptor. */
  readonly scheme: string
  /** Classical account xpub, from `exportAccountXpubFor(masterKey, scheme, account)`. */
  readonly classicalXpub: string
  /** Derive a Falcon address ON THIS SCHEME at a chain/index (seed-backed, async WASM). */
  readonly deriveFalcon: (chain: 0 | 1, index: number) => Promise<string>
  /** Issued PQ indices of this scheme, so the export covers what was handed out. */
  readonly pqFloors: { readonly receive: number; readonly change: number }
}

export interface BuildWatchDescriptorOptions {
  readonly network: Network
  readonly label?: string
  /** One entry per derivation scheme, ACTIVE SCHEME FIRST (consumers treat the
   *  first section as the wallet's primary/display branch). */
  readonly schemes: readonly BuildWatchDescriptorSchemeInput[]
  /** Extra indices beyond the issued ones. Defaults to {@link FALCON_EXPORT_LOOKAHEAD}. */
  readonly lookahead?: { readonly receive: number; readonly change: number }
}

/**
 * Build the watch descriptor of ONE SEED WALLET from ITS OWN master key and
 * meta: one section per registry scheme (active first), each with that
 * scheme's account xpub, Falcon list and issued-index floors.
 *
 * This is the single assembly point for "descriptor of a seed wallet" — the
 * session layer only resolves WHICH master/meta belong to the active wallet
 * and passes them in. Keeping assembly here (pure, injectable) is what makes
 * the master↔meta pairing testable: a descriptor built from wallet B's master
 * must watch B's addresses, never the primary's (regression: the export used
 * to always read the PRIMARY vault's master key).
 */
export async function buildSeedWatchDescriptor(opts: {
  /** The wallet's OWN master key (primary vault or its imported seed). */
  readonly master: HDKey
  /** The same wallet's (per-scheme) issued-index meta. */
  readonly meta: WalletMeta
  readonly network: Network
  readonly label?: string
  readonly account?: number
  readonly lookahead?: { readonly receive: number; readonly change: number }
}): Promise<WatchDescriptorV2> {
  const { master, meta, network, label, lookahead } = opts
  const account = opts.account ?? 0
  return buildWatchDescriptor({
    network,
    ...(label !== undefined ? { label } : {}),
    ...(lookahead !== undefined ? { lookahead } : {}),
    schemes: DERIVATION_SCHEMES.map((scheme) => {
      const floors = indicesFor(meta, scheme.id)
      return {
        scheme: scheme.id,
        classicalXpub: exportAccountXpubFor(master, scheme, network, account),
        deriveFalcon: (chain: 0 | 1, index: number) => deriveFalconAddress(master, { account, chain, index, network, scheme }),
        pqFloors: { receive: floors.pqReceiveIndex, change: floors.pqChangeIndex },
      }
    }),
  })
}

/** Build a (v2) watch descriptor, deriving each scheme's Falcon address list. */
export async function buildWatchDescriptor(opts: BuildWatchDescriptorOptions): Promise<WatchDescriptorV2> {
  if (opts.schemes.length === 0) throw new Error('A watch descriptor needs at least one scheme.')
  const look = opts.lookahead ?? FALCON_EXPORT_LOOKAHEAD
  const schemes: WatchDescriptorScheme[] = []
  for (const s of opts.schemes) {
    const receive = await deriveFalconList(s.deriveFalcon, 0, s.pqFloors.receive + look.receive)
    const change = await deriveFalconList(s.deriveFalcon, 1, s.pqFloors.change + look.change)
    schemes.push({ scheme: s.scheme, classicalXpub: s.classicalXpub, falcon: { receive, change } })
  }
  const base: WatchDescriptorV2 = {
    kind: WATCH_DESCRIPTOR_KIND,
    version: 2,
    network: opts.network,
    schemes,
  }
  const label = opts.label?.trim()
  return label !== undefined && label !== '' ? { ...base, label } : base
}

// Derive Falcon addresses for indices 0..lastIndex (inclusive) on a chain, in order.
async function deriveFalconList(
  deriveFalcon: (chain: 0 | 1, index: number) => Promise<string>,
  chain: 0 | 1,
  lastIndex: number,
): Promise<string[]> {
  const out: string[] = []
  for (let index = 0; index <= lastIndex; index += 1) {
    out.push(await deriveFalcon(chain, index))
  }
  return out
}

// ── Import: parse, validate, (de)serialize ──────────────────────────────────────

/** Serialize a descriptor to a compact JSON string for copy/paste or a file. */
export function encodeWatchDescriptor(descriptor: WatchDescriptor): string {
  return JSON.stringify(descriptor)
}

/** Parse + validate a descriptor from its JSON string. Throws with a reason on failure. */
export function parseWatchDescriptor(json: string): WatchDescriptor {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('Not a valid watch descriptor (invalid JSON).')
  }
  return validateWatchDescriptor(raw)
}

/** Whether `json` is a valid watch descriptor. Never throws. */
export function isValidWatchDescriptor(json: string): boolean {
  try {
    parseWatchDescriptor(json)
    return true
  } catch {
    return false
  }
}

function validateWatchDescriptor(raw: unknown): WatchDescriptor {
  if (typeof raw !== 'object' || raw === null) throw new Error('Watch descriptor must be an object.')
  const d = raw as Record<string, unknown>
  if (d.kind !== WATCH_DESCRIPTOR_KIND) throw new Error('Not a recognized watch descriptor.')
  if (d.network !== 'mainnet' && d.network !== 'testnet') throw new Error('Watch descriptor has an unknown network.')
  const network: Network = d.network
  const label = typeof d.label === 'string' && d.label.trim() !== '' ? d.label.trim() : undefined

  if (d.version === 1) {
    const section = validateSection(d, network, 'Watch descriptor')
    const base: WatchDescriptorV1 = {
      kind: WATCH_DESCRIPTOR_KIND,
      version: 1,
      network,
      classicalXpub: section.classicalXpub,
      falcon: section.falcon,
    }
    return label !== undefined ? { ...base, label } : base
  }

  if (d.version === 2) {
    if (!Array.isArray(d.schemes) || d.schemes.length === 0) {
      throw new Error('Watch descriptor must list at least one scheme.')
    }
    const seen = new Set<string>()
    const schemes = (d.schemes as unknown[]).map((rawSection) => {
      if (typeof rawSection !== 'object' || rawSection === null) {
        throw new Error('Watch descriptor has a malformed scheme section.')
      }
      const s = rawSection as Record<string, unknown>
      if (typeof s.scheme !== 'string' || s.scheme.trim() === '') {
        throw new Error('Watch descriptor has a scheme section without a scheme id.')
      }
      if (seen.has(s.scheme)) throw new Error('Watch descriptor lists the same scheme twice.')
      seen.add(s.scheme)
      const section = validateSection(s, network, `Scheme '${s.scheme}'`)
      return { scheme: s.scheme, classicalXpub: section.classicalXpub, falcon: section.falcon }
    })
    const base: WatchDescriptorV2 = { kind: WATCH_DESCRIPTOR_KIND, version: 2, network, schemes }
    return label !== undefined ? { ...base, label } : base
  }

  throw new Error(`Unsupported watch descriptor version: ${String(d.version)}`)
}

// The xpub + Falcon lists shared by a v1 body and a v2 scheme section.
function validateSection(
  s: Record<string, unknown>,
  network: Network,
  what: string,
): { classicalXpub: string; falcon: { receive: string[]; change: string[] } } {
  if (typeof s.classicalXpub !== 'string' || !isValidAccountXpub(s.classicalXpub)) {
    throw new Error(`${what} has an invalid account xpub.`)
  }
  if (typeof s.falcon !== 'object' || s.falcon === null) throw new Error(`${what} is missing its Falcon section.`)
  const f = s.falcon as Record<string, unknown>
  return {
    classicalXpub: s.classicalXpub,
    falcon: { receive: validateFalconAddresses(f.receive, network), change: validateFalconAddresses(f.change, network) },
  }
}

// Falcon addresses must be valid for the network AND post-quantum (HASH256/32-byte
// scripthash) — a classical address here would be a malformed descriptor.
function validateFalconAddresses(value: unknown, network: Network): string[] {
  if (!Array.isArray(value)) throw new Error('Falcon addresses must be a list.')
  return (value as unknown[]).map((addr) => {
    if (typeof addr !== 'string' || !validateAddress(addr, network)) {
      throw new Error('Watch descriptor contains an invalid Falcon address.')
    }
    if (decodeAddress(addr).type !== 'pq') {
      throw new Error('Watch descriptor contains a non-Falcon address in the Falcon list.')
    }
    return addr
  })
}
