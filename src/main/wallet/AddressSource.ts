import { addressFromXpub, decodeAddress, parseAccountXpub, type HDKey, type Network } from '@qbitcoin/crypto'
import { deriveClassicalAddress, deriveFalconAddress } from './addresses'
import type { Chain, DiscoveryBranch } from './discovery'
import type { WalletMetaStore } from './meta'
import type { WatchDescriptor } from './watchDescriptor'

// The addresses a wallet exposes to chain reads (discovery, balance, history, the
// spend pool), expressed as discovery branches — decoupled from HOW they're produced.
// A seed wallet derives both branches from its master key; a watch wallet derives the
// classical branch from an imported xpub and lists its Falcon addresses (the PQ branch
// is fully hardened and has no xpub). ChainService consumes only this, never a key.
export interface AddressSource {
  /** The wallet's discovery branches. Re-read per call so issued floors stay current. */
  readonly branches: () => Promise<readonly DiscoveryBranch[]>
  /** Drop any per-session caches — called when the wallet locks or is destroyed. */
  readonly reset: () => void
}

// A seed-backed source: classical and Falcon addresses are derived from the Vault's
// master key (read inside main only), with issued-index floors from the sealed meta
// store. Falcon keygen is WASM (slow-ish), so derived PQ addresses are memoised for
// the session; reset() clears that cache whenever the seed could change.
export function createSeedAddressSource(opts: {
  // Async so a non-primary seed wallet can lazily open its sealed seed; the primary
  // wallet resolves it synchronously.
  getMasterKey: () => HDKey | Promise<HDKey>
  // Only the read side is needed (issued floors); typed as a slice so it's trivial
  // to substitute in tests.
  metaStore: Pick<WalletMetaStore, 'load'>
  network: Network
  account?: number
}): AddressSource {
  const { getMasterKey, metaStore, network } = opts
  const account = opts.account ?? 0
  const pqCache = new Map<string, string>()

  const deriveClassical = async (chain: 0 | 1, index: number): Promise<string> =>
    deriveClassicalAddress(await getMasterKey(), { account, chain, index, network })

  const derivePq = async (chain: 0 | 1, index: number): Promise<string> => {
    const key = `${chain}:${index}`
    const hit = pqCache.get(key)
    if (hit !== undefined) return hit
    const addr = await deriveFalconAddress(await getMasterKey(), { account, chain, index, network })
    pqCache.set(key, addr)
    return addr
  }

  const branches = async (): Promise<readonly DiscoveryBranch[]> => {
    const meta = await metaStore.load()
    return [
      { kind: 'derive', algo: 'ecdsa', derive: deriveClassical, floors: { receive: meta.receiveIndex, change: meta.changeIndex } },
      { kind: 'derive', algo: 'falcon512', derive: derivePq, floors: { receive: meta.pqReceiveIndex, change: meta.pqChangeIndex } },
    ]
  }

  return { branches, reset: () => pqCache.clear() }
}

// A watch wallet built from a {@link WatchDescriptor}: the classical branch is
// gap-scanned via public CKD from the account xpub (so it finds addresses without the
// seed), and the Falcon branch is the descriptor's fixed, immutable address list.
export function createDescriptorAddressSource(descriptor: WatchDescriptor): AddressSource {
  const account = parseAccountXpub(descriptor.classicalXpub)
  const { network, falcon } = descriptor
  const branches = (): Promise<readonly DiscoveryBranch[]> =>
    Promise.resolve([
      {
        kind: 'derive',
        algo: 'ecdsa',
        derive: (chain: 0 | 1, index: number) => addressFromXpub(account, chain, index, network),
        // No issued floor on a watch wallet — gap-scan from index 0.
        floors: { receive: 0, change: 0 },
      },
      { kind: 'list', algo: 'falcon512', addresses: positioned(falcon.receive, falcon.change) },
    ])
  return { branches, reset: () => undefined }
}

// A watch wallet from a bare address list (no xpub): every address is fixed. Each is
// classified by type — classical (HASH160) or PQ (HASH256) — into its own branch.
// Index is positional (a pasted list has no derivation meaning). Addresses must be
// pre-validated by the caller; decodeAddress throws on a malformed one.
export function createAddressListSource(addresses: readonly string[]): AddressSource {
  const classical: { chain: Chain; index: number; address: string }[] = []
  const falcon: { chain: Chain; index: number; address: string }[] = []
  for (const address of addresses) {
    const bucket = decodeAddress(address).type === 'pq' ? falcon : classical
    bucket.push({ chain: 0, index: bucket.length, address })
  }
  const list: DiscoveryBranch[] = []
  if (classical.length > 0) list.push({ kind: 'list', algo: 'ecdsa', addresses: classical })
  if (falcon.length > 0) list.push({ kind: 'list', algo: 'falcon512', addresses: falcon })
  return { branches: () => Promise.resolve(list), reset: () => undefined }
}

// Pair receive/change address lists with their positional (chain, index) for discovery.
function positioned(receive: readonly string[], change: readonly string[]): { chain: Chain; index: number; address: string }[] {
  return [
    ...receive.map((address, index) => ({ chain: 0 as Chain, index, address })),
    ...change.map((address, index) => ({ chain: 1 as Chain, index, address })),
  ]
}
