import {
  activeScheme,
  deriveFalconKeypair,
  derivePath,
  nativePathFor,
  fromHex,
  requireScheme,
  serialize,
  signTransaction,
  toHex,
  TX_TYPE_STANDARD,
  TX_TYPE_TOKENS,
  txid as computeTxid,
  type HDKey,
  type Network,
  type SigningInput,
  type Transaction,
  type TxInput,
  type TxOutput,
} from '@qbitcoin/crypto'
import type { UnsignedTx } from './buildTx'

export interface SignedTx {
  readonly rawHex: string
  readonly txid: string
}

/** Map an unsigned draft to the crypto Transaction skeleton (no signatures).
 *  txids go in verbatim (wire order); the sighash covers inputs + outputs. A token
 *  transfer (tokenHash set) becomes TX_TYPE_TOKENS with the token-id prefix and the
 *  per-output TRANSFER `data`; the crypto serializer puts the prefix on the wire but
 *  keeps it out of the sighash, so signing stays token-agnostic. */
export function toCryptoTransaction(unsigned: UnsignedTx): Transaction {
  return {
    txType: unsigned.tokenHash !== undefined ? TX_TYPE_TOKENS : TX_TYPE_STANDARD,
    tokenHash: unsigned.tokenHash !== undefined ? fromHex(unsigned.tokenHash) : undefined,
    inputs: unsigned.inputs.map((i): TxInput => ({ txid: fromHex(i.prevTxid), vout: i.vout })),
    outputs: unsigned.outputs.map(
      (o): TxOutput => ({
        value: BigInt(o.valueAtomic),
        scripthash: fromHex(o.scripthash),
        data: o.data !== undefined ? fromHex(o.data) : undefined,
      }),
    ),
  }
}

// Sign every input with a key derived from the master key on that input's own
// branch AND derivation scheme. Runs in main only; each derived private key is
// wiped immediately after signing. Returns the signed Transaction (siglist +
// redeem script attached).
export async function buildSignedTransaction(unsigned: UnsignedTx, master: HDKey, network: Network): Promise<Transaction> {
  const tx = toCryptoTransaction(unsigned)
  // Each input is signed on its own branch by its own algorithm: classical inputs
  // with a secp256k1 child key (sync), PQ inputs with a Falcon-512 keypair (async,
  // WASM keygen). The input's scheme decides the coin_type level of the path —
  // a legacy-scheme UTXO must be signed with the key at its OWN path, not the
  // active scheme's. An unknown scheme id is refused loudly (signing with a
  // wrong-path key would produce an unbroadcastable transaction); an absent one
  // falls back to the active scheme (inputs from pre-multi-scheme drafts).
  // signTransaction dispatches the actual signing per `algo`.
  const signers: SigningInput[] = await Promise.all(
    unsigned.inputs.map(async (input, index): Promise<SigningInput> => {
      const kp = await deriveInputKeypair(master, input, network)
      return { inputIndex: index, privateKey: kp.privateKey, publicKey: kp.publicKey, algo: input.algo === 'falcon512' ? 'falcon512' : 'ecdsa' }
    }),
  )
  try {
    return await signTransaction(tx, signers)
  } finally {
    for (const signer of signers) signer.privateKey.fill(0)
  }
}

/**
 * Key material for one input, derived on its own branch and scheme (a
 * legacy-scheme UTXO must be signed with the key at its OWN path). Exposed for
 * flows that need an input's key OUTSIDE plain signing — the downgrade freeze
 * commits hash256 of its first input's pubkey, and the reclaim later signs
 * with that same key. Callers wipe `privateKey` after use.
 */
export async function deriveInputKeypair(
  master: HDKey,
  input: { readonly account: number; readonly chain: 0 | 1; readonly index: number; readonly algo: string; readonly scheme?: string },
  network: Network,
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const scheme = input.scheme !== undefined ? requireScheme(input.scheme) : activeScheme()
  if (input.algo === 'falcon512') {
    const kp = await deriveFalconKeypair(master, input.account, input.chain, input.index, network, scheme)
    return { privateKey: kp.privateKey, publicKey: kp.publicKey }
  }
  if (input.algo !== 'ecdsa') {
    throw new Error(`Unsupported signing algorithm: ${input.algo}`)
  }
  const child = derivePath(master, nativePathFor(scheme, input.account, input.index, network, input.chain))
  if (child.privateKey === null || child.publicKey === null) {
    throw new Error('No key material for input')
  }
  return { privateKey: child.privateKey, publicKey: child.publicKey }
}

/** Sign, serialize, and compute the txid. The wire hex is what gets broadcast. */
export async function signUnsignedTx(unsigned: UnsignedTx, master: HDKey, network: Network): Promise<SignedTx> {
  const signed = await buildSignedTransaction(unsigned, master, network)
  return { rawHex: toHex(serialize(signed)), txid: toHex(computeTxid(signed)) }
}
