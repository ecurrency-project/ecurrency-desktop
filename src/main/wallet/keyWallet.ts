import {
  falconKeypairFromWifPayload,
  getPublicKey,
  schnorrGetPublicKey,
  serialize,
  SIGHASH,
  signTransaction,
  toHex,
  txid as computeTxid,
  type Algorithm,
  type Network,
  type SigningInput,
} from '@qbtc/crypto'
import {
  addressFromPubkey,
  decodeWif,
  sighashCommitsTokenId,
} from '../brand/crypto'
import type { AddressOps } from '../vault/orchestrator'
import type { AddressSource } from './AddressSource'
import type { UnsignedTx } from './buildTx'
import type { StoredKey } from './keyStore'
import { toCryptoTransaction, type SignedTx } from './signTx'

// A single imported private key (kind: 'key' wallet) — the building blocks.
//
// A key wallet has exactly ONE address, decided at import: no HD tree, no
// fresh receive/change addresses. Change from its sends returns to the same
// address (accepted trade-off: the pubkey is public on-chain after the first
// spend). Raw signing keys stay in main; WIF backup is a separate, explicit
// password-authenticated operation in WalletBackupService.

/** An imported key, materialized for a session: raw key material + address. */
export interface ImportedKey {
  readonly algo: Algorithm
  /** SECRET. Owned by the session cache; wiped on lock/switch. */
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
  readonly address: string
}

/**
 * Materialize a stored key: decode the WIF, derive the public key for the
 * stored algorithm, and recompute the address. The recomputed address is
 * compared against the stored one — a mismatch means the blob was tampered
 * with or produced by an incompatible build, and must not be spent from.
 *
 * Async: a Falcon key runs its pair self-check in WASM.
 */
export async function importedKeyFromStored(stored: StoredKey, network: Network): Promise<ImportedKey> {
  const { payload, candidates } = decodeWif(stored.wif, network)
  if (!candidates.includes(stored.algo)) {
    payload.fill(0)
    throw new Error(`This key cannot be used as ${stored.algo}.`)
  }

  try {
    let key: ImportedKey
    if (stored.algo === 'falcon512') {
      const kp = await falconKeypairFromWifPayload(payload)
      payload.fill(0) // the keypair holds its own copies
      key = { algo: stored.algo, privateKey: kp.privateKey, publicKey: kp.publicKey, address: addressFromPubkey(kp.publicKey, stored.algo, network) }
    } else {
      // For classical keys the payload IS the private key — hand it over (the
      // session cache owns and wipes it).
      const publicKey = stored.algo === 'schnorr' ? schnorrGetPublicKey(payload) : getPublicKey(payload)
      key = { algo: stored.algo, privateKey: payload, publicKey, address: addressFromPubkey(publicKey, stored.algo, network) }
    }

    if (stored.address !== '' && key.address !== stored.address) {
      key.privateKey.fill(0)
      throw new Error('Stored key data is inconsistent (address mismatch) — refusing to use it.')
    }
    return key
  } catch (error) {
    payload.fill(0)
    throw error
  }
}

/** The discovery source of a key wallet: one fixed address on the key's branch. */
export function createKeyAddressSource(getKey: () => Promise<ImportedKey>): AddressSource {
  return {
    branches: async () => {
      const key = await getKey()
      return [{ kind: 'list', algo: key.algo, addresses: [{ chain: 0, index: 0, address: key.address }] }]
    },
    // The session owns the key cache; nothing extra to drop here.
    reset: () => undefined,
  }
}

// Receive ops for a key wallet: there is only ever the one address. "New
// address" cannot advance anything (no derivation), so it returns the same
// address — mirroring how watch wallets behave.
export function keyReceiveOps(getKey: () => Promise<ImportedKey>): AddressOps {
  const address = async (): Promise<string> => (await getKey()).address
  return {
    getReceiveAddress: () => address(),
    getNewReceiveAddress: () => address(),
    listReceiveAddresses: async () => [{ address: await address(), index: 0, current: true }],
  }
}

/** What a pasted WIF could be: candidate algorithms + the address each would watch. */
export interface KeyCandidates {
  readonly candidates: readonly Algorithm[]
  readonly addresses: Partial<Record<Algorithm, string>>
}

/**
 * Inspect a WIF without persisting anything: which algorithms the payload
 * admits and the single address each candidate would give — so the import UI
 * can show the address for confirmation before anything is saved. Schnorr is
 * listed only when explicitly included (the feature flag decides upstream).
 */
export async function inspectWifKey(wif: string, network: Network, opts?: { readonly includeSchnorr?: boolean }): Promise<KeyCandidates> {
  const { payload, candidates } = decodeWif(wif, network)
  const offered = candidates.filter((a) => a !== 'schnorr' || opts?.includeSchnorr === true)
  const addresses: Partial<Record<Algorithm, string>> = {}
  try {
    for (const algo of offered) {
      if (algo === 'falcon512') {
        const kp = await falconKeypairFromWifPayload(payload)
        kp.privateKey.fill(0)
        addresses[algo] = addressFromPubkey(kp.publicKey, algo, network)
      } else {
        addresses[algo] = addressFromPubkey(algo === 'schnorr' ? schnorrGetPublicKey(payload) : getPublicKey(payload), algo, network)
      }
    }
  } finally {
    payload.fill(0)
  }
  return { candidates: offered, addresses }
}

/**
 * Sign every input of a draft with the imported key. Unlike the HD signer
 * (signTx.ts), the key is session-cached and NOT wiped after signing — the
 * session owns its lifetime (wiped on lock/switch).
 *
 * A key wallet's discovery only ever surfaces its own address, so every input
 * must match the key's algorithm; a mismatch means a programming error and is
 * refused loudly.
 */
export async function signUnsignedTxWithKey(unsigned: UnsignedTx, key: ImportedKey, network: Network): Promise<SignedTx> {
  const tx = toCryptoTransaction(unsigned)
  const signers: SigningInput[] = unsigned.inputs.map((input, index) => {
    if (input.algo !== key.algo) {
      throw new Error(`Input ${index} expects a ${input.algo} key, but the imported key is ${key.algo}.`)
    }
    return { inputIndex: index, privateKey: key.privateKey, publicKey: key.publicKey, algo: key.algo }
  })
  const signed = await signTransaction(tx, signers, SIGHASH.ALL, sighashCommitsTokenId(network))
  return { rawHex: toHex(serialize(signed)), txid: toHex(computeTxid(signed)) }
}
