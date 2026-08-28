import type { Utxo } from '@qbitcoin/chain'
import type { Network } from '@qbitcoin/crypto'
import { ChainService, type ChainBackend } from './ChainService'
import { createKeyAddressSource, signUnsignedTxWithKey, type ImportedKey } from './keyWallet'
import { SendService } from './SendService'
import { gatherFromActive, type GatheredUtxo } from './spendable'

// Ephemeral "send from a private key" (sweep) session.
//
// Unlike a key WALLET (kind: 'key'), a sweep never touches disk: the key is
// materialized from a pasted WIF, held in memory for the duration of the
// wizard, and wiped on confirm/cancel/lock. Nothing is written to the
// registry, no sealed store is created, and the active wallet is untouched —
// this is the Sparrow "Sweep Private Key" model (key lives only in the dialog).
//
// It reuses the exact send pipeline (ChainService + SendService + buildTx +
// keyWallet signing) so a swept transaction is assembled and signed the same
// way as any other. Change (for a partial send) returns to the key's own
// address; a full sweep produces no change.

// The chain access a sweep needs: everything ChainService reads, plus the UTXO
// pull for the spend pool and broadcast. The real ChainClient satisfies it.
export interface SweepBackend extends ChainBackend {
  listUnspent(address: string): Promise<Utxo[]>
  broadcastTransaction(rawHex: string): Promise<{ txid: string }>
}

export interface SweepSession {
  /** The key's single address (what's being swept from). */
  readonly address: string
  /** The send driver — buildSend/maxSendable/confirmSend, same as any wallet. */
  readonly send: SendService
  /** Confirmed + mempool balance on the key's address, as an atomic string. */
  scanBalance(): Promise<{ balanceAtomic: string }>
  /** Wipe the key from memory. Idempotent; the session is unusable afterwards. */
  dispose(): void
}

// Build an ephemeral sweep session around an already-materialized key. The
// caller owns the key's lifetime only up to here — dispose() wipes it.
export function createSweepSession(backend: SweepBackend, key: ImportedKey, network: Network): SweepSession {
  const source = createKeyAddressSource(() => Promise.resolve(key))
  const chain = new ChainService(backend, source.branches)
  const gather = async (): Promise<GatheredUtxo[]> => gatherFromActive(await chain.spendableAddresses(), backend)

  const ownAddress = (): Promise<string> => Promise.resolve(key.address)
  const send = new SendService({
    gather,
    feeRate: async () => (await chain.estimateFee()).medium,
    // An ephemeral sweep has no coin-control state — nothing is frozen.
    frozen: () => Promise.resolve(new Set<string>()),
    // No derivation: any change returns to the key's own address (address reuse
    // is inherent to single keys); there is no index to advance.
    getChangeAddress: ownAddress,
    getPqChangeAddress: ownAddress,
    advanceChange: () => Promise.resolve(),
    sign: (unsigned) => signUnsignedTxWithKey(unsigned, key, network),
    broadcast: async (rawHex) => (await backend.broadcastTransaction(rawHex)).txid,
  })

  return {
    address: key.address,
    send,
    scanBalance: async () => ({ balanceAtomic: (await chain.getSummary()).balanceAtomic }),
    dispose: () => {
      send.reset()
      key.privateKey.fill(0)
    },
  }
}
