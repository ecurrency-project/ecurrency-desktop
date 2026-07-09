import { DERIVATION_SCHEMES, addressFromXpub, decodeAddress, parseAccountXpub, type DerivationScheme, type HDKey, type Network } from '@qbitcoin/crypto'
import { deriveClassicalAddress, deriveFalconAddress } from './addresses'
import type { Chain, DiscoveryBranch } from './discovery'
import { indicesFor } from './meta'
import type { WalletMetaStore } from './meta'
import { descriptorSchemes, type WatchDescriptor } from './watchDescriptor'

// The addresses a wallet exposes to chain reads (discovery, balance, history, the
// spend pool), expressed as discovery branches — decoupled from HOW they're produced.
// A seed wallet derives branches from its master key for EVERY derivation scheme
// (classical + PQ per scheme — legacy schemes are scanned forever so old funds stay
// visible and spendable); a watch wallet derives classical branches from imported
// xpubs and lists its Falcon addresses (the PQ branch is fully hardened and has no
// xpub). ChainService consumes only this, never a key.
export interface AddressSource {
  /** The wallet's discovery branches. Re-read per call so issued floors stay current. */
  readonly branches: () => Promise<readonly DiscoveryBranch[]>
  /** Drop any per-session caches — called when the wallet locks or is destroyed. */
  readonly reset: () => void
}

// A seed-backed source: classical and Falcon addresses are derived from the Vault's
// master key (read inside main only), with issued-index floors from the sealed meta
// store — per scheme. Falcon keygen is WASM (slow-ish), so derived PQ addresses are
// memoised for the session; reset() clears that cache whenever the seed could change.
export function createSeedAddressSource(opts: {
  // Async so a non-primary seed wallet can lazily open its sealed seed; the primary
  // wallet resolves it synchronously.
  getMasterKey: () => HDKey | Promise<HDKey>
  // Only the read side is needed (issued floors); typed as a slice so it's trivial
  // to substitute in tests.
  metaStore: Pick<WalletMetaStore, 'load'>
  network: Network
  account?: number
  // The schemes to expose (active first). Defaults to the registry; injectable
  // so tests can exercise multi-scheme behaviour with fake schemes.
  schemes?: readonly DerivationScheme[]
}): AddressSource {
  const { getMasterKey, metaStore, network } = opts
  const account = opts.account ?? 0
  const schemes = opts.schemes ?? DERIVATION_SCHEMES
  const pqCache = new Map<string, string>()

  const deriveClassical = async (scheme: DerivationScheme, chain: 0 | 1, index: number): Promise<string> =>
    deriveClassicalAddress(await getMasterKey(), { account, chain, index, network, scheme })

  const derivePq = async (scheme: DerivationScheme, chain: 0 | 1, index: number): Promise<string> => {
    const key = `${scheme.id}:${chain}:${index}`
    const hit = pqCache.get(key)
    if (hit !== undefined) return hit
    const addr = await deriveFalconAddress(await getMasterKey(), { account, chain, index, network, scheme })
    pqCache.set(key, addr)
    return addr
  }

  const branches = async (): Promise<readonly DiscoveryBranch[]> => {
    const meta = await metaStore.load()
    return schemes.flatMap((scheme): DiscoveryBranch[] => {
      const floors = indicesFor(meta, scheme.id)
      return [
        {
          kind: 'derive',
          algo: 'ecdsa',
          scheme: scheme.id,
          derive: (chain, index) => deriveClassical(scheme, chain, index),
          floors: { receive: floors.receiveIndex, change: floors.changeIndex },
        },
        {
          kind: 'derive',
          algo: 'falcon512',
          scheme: scheme.id,
          derive: (chain, index) => derivePq(scheme, chain, index),
          floors: { receive: floors.pqReceiveIndex, change: floors.pqChangeIndex },
        },
      ]
    })
  }

  return { branches, reset: () => pqCache.clear() }
}

// A watch wallet built from a {@link WatchDescriptor}: per scheme section, the
// classical branch is gap-scanned via public CKD from that scheme's account xpub (so
// it finds addresses without the seed), and the Falcon branch is the section's fixed,
// immutable address list. Sections come active-scheme-first from the export, so the
// first branch of an algo is the wallet's primary one.
export function createDescriptorAddressSource(descriptor: WatchDescriptor): AddressSource {
  const { network } = descriptor
  const sections = descriptorSchemes(descriptor).map((section) => ({
    scheme: section.scheme,
    account: parseAccountXpub(section.classicalXpub),
    falcon: section.falcon,
  }))
  const branches = (): Promise<readonly DiscoveryBranch[]> =>
    Promise.resolve(
      sections.flatMap((section): DiscoveryBranch[] => [
        {
          kind: 'derive',
          algo: 'ecdsa',
          scheme: section.scheme,
          derive: (chain: 0 | 1, index: number) => addressFromXpub(section.account, chain, index, network),
          // No issued floor on a watch wallet — gap-scan from index 0.
          floors: { receive: 0, change: 0 },
        },
        { kind: 'list', algo: 'falcon512', scheme: section.scheme, addresses: positioned(section.falcon.receive, section.falcon.change) },
      ]),
    )
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
