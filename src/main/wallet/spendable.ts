import type { Utxo } from '@qbitcoin/chain'
import type { SpendableUtxo } from './buildTx'
import { discoverAll, isActive, type AddressLookup, type Algo, type DeriveAddress, type DiscoveredAddress } from './discovery'

/** Chain access the spendable gatherer needs. */
export interface SpendableBackend extends AddressLookup {
  listUnspent(address: string): Promise<Utxo[]>
}

/** A spendable UTXO enriched with coin-control fields (owning address +
 *  confirmation state). Still assignable to SpendableUtxo for tx building. */
export interface GatheredUtxo extends SpendableUtxo {
  readonly address: string
  readonly confirmed: boolean
  readonly blockHeight?: number
  /** Set on a token UTXO: the token id (hex) and its atomic token amount. Native
   *  UTXOs leave both undefined (and carry the native value in `value`). */
  readonly tokenId?: string
  readonly tokenAmount?: bigint
}

/** An extra HD branch to gather alongside the classical one (e.g. Falcon PQ).
 *  Carries the algorithm so each UTXO is tagged for the signer + coin control. */
export interface SpendBranch {
  readonly algo: Algo
  readonly derive: DeriveAddress
  readonly floors: { receive: number; change: number }
}

// Discover the wallet's addresses across every branch (classical + any extra,
// e.g. Falcon), pull each one's UTXOs, and tag them with the owning address,
// algorithm, coords, and confirmation so the signer can derive the right key and
// coin control can display them. Token UTXOs (tokenId set, native value 0) are
// included and tagged with their token id/amount; native-only consumers filter
// them out, while the token-send path selects by token id.
export async function gatherSpendable(
  derive: DeriveAddress,
  backend: SpendableBackend,
  floors: { receive: number; change: number },
  extraBranches: readonly SpendBranch[] = [],
): Promise<GatheredUtxo[]> {
  const branches: readonly SpendBranch[] = [{ algo: 'ecdsa', derive, floors }, ...extraBranches]
  // Branches are independent, so gather them concurrently.
  const perBranch = await Promise.all(
    branches.map(async (branch): Promise<GatheredUtxo[]> => {
      const discovered = await discoverAll(branch.derive, backend, branch.floors)
      const active = activeFrom(discovered, branch.algo)
      return gatherFromActive(active, backend)
    }),
  )
  return perBranch.flat()
}

/** A discovered, active address to pull UTXOs from, tagged with its branch's
 *  signature scheme (so each UTXO is attributed to the right key for signing). */
export type ActiveAddress = Pick<DiscoveredAddress, 'address' | 'chain' | 'index'> & { readonly algo: Algo }

/** The active subset of a branch's discovered addresses (the inactive gap-padding
 *  can't hold UTXOs), tagged with the branch's scheme. */
export function activeFrom(discovered: readonly DiscoveredAddress[], algo: Algo): ActiveAddress[] {
  return discovered.filter((entry) => isActive(entry.info)).map((entry) => ({ address: entry.address, chain: entry.chain, index: entry.index, algo }))
}

// Pull UTXOs for already-discovered active addresses and tag them for the signer
// and coin control. Kept separate from discovery so the address gap-scan can be
// done once and shared — the chain service and the spend pool no longer each
// re-scan every address. listUnspent runs in parallel across the active set.
export async function gatherFromActive(active: readonly ActiveAddress[], backend: Pick<SpendableBackend, 'listUnspent'>): Promise<GatheredUtxo[]> {
  const withUtxos = await Promise.all(active.map(async (a) => ({ a, utxos: await backend.listUnspent(a.address) })))
  const out: GatheredUtxo[] = []
  for (const { a, utxos } of withUtxos) {
    for (const utxo of utxos) {
      out.push({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        chain: a.chain,
        index: a.index,
        algo: a.algo,
        address: a.address,
        confirmed: utxo.status.confirmed,
        blockHeight: utxo.status.blockHeight,
        tokenId: utxo.tokenId,
        tokenAmount: utxo.tokenAmount,
      })
    }
  }
  return out
}
