import type { AddressInfo } from '@qbitcoin/chain'
import type { Algorithm } from '@qbitcoin/crypto'

export type Chain = 0 | 1
// May be async: the classical branch derives synchronously, the Falcon (PQ)
// branch runs WASM keygen and returns a promise. discoverChain awaits either.
export type DeriveAddress = (chain: Chain, index: number) => string | Promise<string>

/** The subset of the chain backend discovery needs. */
export interface AddressLookup {
  getAddressInfo(address: string): Promise<AddressInfo>
}

export interface DiscoveredAddress {
  readonly chain: Chain
  readonly index: number
  readonly address: string
  readonly info: AddressInfo
}

// Per-chain gap limits. The external (receive) chain uses the de-facto standard
// 20; the internal (change) chain uses 6 so the wallet stays recoverable by
// wallets that scan change with a smaller gap (Electrum/BitBox) — Sparrow's
// recommendation.
export const GAP_LIMIT_RECEIVE = 20
export const GAP_LIMIT_CHANGE = 6

/** Hard cap so a misbehaving node can't make us scan forever. */
const MAX_SCAN = 1000

/** An address has on-chain or mempool history (funded or spent). */
export function isActive(info: AddressInfo): boolean {
  return (
    info.chain.fundedTxCount > 0 ||
    info.chain.spentTxCount > 0 ||
    info.mempool.fundedTxCount > 0 ||
    info.mempool.spentTxCount > 0
  )
}

// Scan one BIP-44 chain (0 = receive, 1 = change) from index 0. Keeps scanning
// while addresses are active OR index <= floor (issued-but-maybe-unfunded), and
// stops after `gapLimit` consecutive inactive addresses beyond the floor. Returns
// every address it touched — inactive ones contribute 0 to the balance, so
// including them is harmless and keeps the issued/current address in view.
//
// Addresses are fetched in parallel windows instead of one round-trip at a time:
// each window is sized to the minimum that could close the gap from the current
// position (indices still below the floor, plus the run of inactive addresses
// still needed). The window's results are folded in index order with the exact
// same stop rule as a sequential scan, so the returned set is identical — only the
// network latency is collapsed from ~one-RTT-per-address to ~one-RTT-per-window.
export async function discoverChain(
  derive: DeriveAddress,
  lookup: AddressLookup,
  chain: Chain,
  floor: number,
  gapLimit: number,
): Promise<DiscoveredAddress[]> {
  const found: DiscoveredAddress[] = []
  let consecutiveInactive = 0
  let index = 0
  while (index < MAX_SCAN) {
    const toFloor = Math.max(0, floor - index)
    const windowSize = Math.max(1, Math.min(toFloor + (gapLimit - consecutiveInactive), MAX_SCAN - index))
    const batch = await Promise.all(
      Array.from({ length: windowSize }, async (_, k) => {
        const i = index + k
        const address = await derive(chain, i)
        return { chain, index: i, address, info: await lookup.getAddressInfo(address) }
      }),
    )
    let stop = false
    for (const entry of batch) {
      found.push(entry)
      if (isActive(entry.info)) {
        consecutiveInactive = 0
      } else if (entry.index >= floor) {
        consecutiveInactive++
        if (consecutiveInactive >= gapLimit) {
          stop = true
          break
        }
      }
    }
    if (stop) break
    index += windowSize
  }
  return found
}

/** Discover the receive (chain 0, gap 20) and change (chain 1, gap 6) chains. */
export async function discoverAll(
  derive: DeriveAddress,
  lookup: AddressLookup,
  floors: { receive: number; change: number },
): Promise<DiscoveredAddress[]> {
  const [receive, change] = await Promise.all([
    discoverChain(derive, lookup, 0, floors.receive, GAP_LIMIT_RECEIVE),
    discoverChain(derive, lookup, 1, floors.change, GAP_LIMIT_CHANGE),
  ])
  return [...receive, ...change]
}

// ── Multi-branch discovery (seed, xpub, and fixed watch lists) ──────────────────

/** The signing scheme an address uses — the wallet-layer alias for the crypto
 *  package's Algorithm, so the union is defined in exactly one place. Schnorr
 *  appears only via imported keys (feature-gated); HD branches derive ECDSA
 *  and Falcon-512. */
export type Algo = Algorithm

// A derivable branch (seed or xpub): addresses are produced by index and gap-scanned.
export interface DeriveBranch {
  readonly kind: 'derive'
  readonly algo: Algo
  readonly derive: DeriveAddress
  readonly floors: { receive: number; change: number }
}

// A fixed branch (a watch wallet's Falcon addresses, or a pasted address list): the
// addresses can't be re-derived, so the list is the whole universe to check.
export interface ListBranch {
  readonly kind: 'list'
  readonly algo: Algo
  readonly addresses: readonly { chain: Chain; index: number; address: string }[]
}

export type DiscoveryBranch = DeriveBranch | ListBranch

// Discover the addresses of one branch: gap-scan a derivable branch, or look up every
// address of a fixed list directly (no gap logic — the list is exhaustive).
export async function discoverBranch(branch: DiscoveryBranch, lookup: AddressLookup): Promise<DiscoveredAddress[]> {
  if (branch.kind === 'derive') return discoverAll(branch.derive, lookup, branch.floors)
  return Promise.all(
    branch.addresses.map(async ({ chain, index, address }) => ({
      chain,
      index,
      address,
      info: await lookup.getAddressInfo(address),
    })),
  )
}
