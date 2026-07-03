import { decodeAddress, isValidAccountXpub, validateAddress, type Network } from '@qbitcoin/crypto'

// A portable, key-free description of a wallet to watch, carried between machines as
// a single JSON token. It pairs the classical account xpub (public CKD reproduces
// every classical address) with an explicit list of Falcon addresses — the PQ branch
// is fully hardened and has no xpub, so a watcher can only see the addresses the
// source wallet derived and exported. After generating more PQ addresses on the
// source wallet, re-export to extend the watched range.

// BRAND VALUE: the kind tag is persisted inside exported descriptors, so a
// brand must never change it once shipped (existing exports would stop
// importing). Brand branches set their own tag.
export const WATCH_DESCRIPTOR_KIND = 'qbt-watch'
export const WATCH_DESCRIPTOR_VERSION = 1

// Indices to include beyond the issued PQ index when exporting the Falcon list, so a
// watcher sees a few not-yet-issued addresses (mirrors classical gap limits: 20/6).
export const FALCON_EXPORT_LOOKAHEAD = { receive: 20, change: 6 } as const

export interface WatchDescriptor {
  readonly kind: typeof WATCH_DESCRIPTOR_KIND
  readonly version: number
  readonly network: Network
  readonly label?: string
  /** Account-level xpub for the classical (secp256k1) branch. */
  readonly classicalXpub: string
  /** Explicit Falcon addresses by chain; array position = derivation index. */
  readonly falcon: {
    readonly receive: readonly string[]
    readonly change: readonly string[]
  }
}

// ── Export: build a descriptor from the active seed wallet ──────────────────────

export interface BuildWatchDescriptorOptions {
  readonly network: Network
  readonly label?: string
  /** Classical account xpub, from `exportAccountXpub(masterKey, account)`. */
  readonly classicalXpub: string
  /** Derive a Falcon address on a chain at an index (seed-backed, async WASM). */
  readonly deriveFalcon: (chain: 0 | 1, index: number) => Promise<string>
  /** Issued PQ indices, so the export covers what the wallet has handed out. */
  readonly pqFloors: { readonly receive: number; readonly change: number }
  /** Extra indices beyond the issued ones. Defaults to {@link FALCON_EXPORT_LOOKAHEAD}. */
  readonly lookahead?: { readonly receive: number; readonly change: number }
}

/** Build a watch descriptor for the active wallet, deriving the Falcon address list. */
export async function buildWatchDescriptor(opts: BuildWatchDescriptorOptions): Promise<WatchDescriptor> {
  const look = opts.lookahead ?? FALCON_EXPORT_LOOKAHEAD
  const receive = await deriveFalconList(opts.deriveFalcon, 0, opts.pqFloors.receive + look.receive)
  const change = await deriveFalconList(opts.deriveFalcon, 1, opts.pqFloors.change + look.change)
  const base: WatchDescriptor = {
    kind: WATCH_DESCRIPTOR_KIND,
    version: WATCH_DESCRIPTOR_VERSION,
    network: opts.network,
    classicalXpub: opts.classicalXpub,
    falcon: { receive, change },
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
  if (d.version !== WATCH_DESCRIPTOR_VERSION) throw new Error(`Unsupported watch descriptor version: ${String(d.version)}`)
  if (d.network !== 'mainnet' && d.network !== 'testnet') throw new Error('Watch descriptor has an unknown network.')
  const network: Network = d.network
  if (typeof d.classicalXpub !== 'string' || !isValidAccountXpub(d.classicalXpub)) {
    throw new Error('Watch descriptor has an invalid account xpub.')
  }
  if (typeof d.falcon !== 'object' || d.falcon === null) throw new Error('Watch descriptor is missing its Falcon section.')
  const f = d.falcon as Record<string, unknown>
  const falcon = { receive: validateFalconAddresses(f.receive, network), change: validateFalconAddresses(f.change, network) }
  const label = typeof d.label === 'string' && d.label.trim() !== '' ? d.label.trim() : undefined
  const base: WatchDescriptor = {
    kind: WATCH_DESCRIPTOR_KIND,
    version: WATCH_DESCRIPTOR_VERSION,
    network,
    classicalXpub: d.classicalXpub,
    falcon,
  }
  return label !== undefined ? { ...base, label } : base
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
