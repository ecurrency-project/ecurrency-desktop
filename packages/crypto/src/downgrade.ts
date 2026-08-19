// The native→BTC downgrade: freeze/downgrade output scripts and the user
// reclaim, ported byte-exactly from the node's chain parameters.
//
// The flow's three on-chain steps:
//   1. The USER pays into a freeze output (a standard transaction): value to
//      the freeze scripthash, data = [reclaim_id: 32][btc scriptPubKey].
//   2. The conversion service spends the freeze in a TX_TYPE_DOWNGRADE
//      (only it can — the IF branch checks the lock key), committing to a
//      BTC payment; a TX_TYPE_BURN completes it permissionlessly once the
//      payment confirms (SPV-verified, no signature).
//   3. If either step never comes, the USER reclaims through the ELSE
//      branch after the CSV window — that signing lives here too.
//
// Script template (shared by freeze and downgrade outputs):
//
//   OP_IF <if-branch> OP_ELSE
//     <csv:4 LE> OP_CSV OP_DROP
//     OP_OUTPUTDATA <0> <32> OP_SUBSTR   -- reclaim_id from the output data
//     OP_OVER OP_HASH256 OP_EQUALVERIFY OP_CHECKSIG
//   OP_ENDIF
//
// reclaim_id is ALWAYS hash256(pubkey): one script serves both classical and
// post-quantum reclaim keys (OP_CHECKSIG dispatches on the signature class).
//
// The CSV constant is time-based: value = floor(seconds/10) | (1<<27); the
// interpreter turns it into a minimum age of the spent output (block time),
// NOT a transaction field — a reclaim transaction is structurally ordinary
// and simply stays invalid until the output is old enough.
//
// Brand values (the lock pubkey and windows) live in constants.ts DOWNGRADE;
// everything here is generic mechanics.

import { hash160, hash256 } from './hashes';
import { sighash, TX_TYPE_STANDARD, type Transaction, type TxInput, type TxOutput } from './transaction';
import { encodeSiglistEntry, signWithAlgorithm, type SigningInput } from './signing';
import { SIGHASH } from './constants';

// Opcode bytes (matching the node's script engine).
const OP_1 = 0x51;
const OP_6 = 0x56;
const OP_7 = 0x57;
const OP_IF = 0x63;
const OP_ELSE = 0x67;
const OP_ENDIF = 0x68;
const OP_DROP = 0x75;
const OP_OVER = 0x78;
const OP_TX_TYPE = 0x7e;
const OP_SUBSTR = 0x7f;
const OP_OUTPUTDATA = 0x80;
const OP_EQUALVERIFY = 0x88;
const OP_HASH256 = 0xaa;
const OP_CHECKSIG = 0xac;
const OP_CSV = 0xb2;

/** Direct pushdata (lengths this module uses are all ≤ 75 bytes). */
function push(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length > 75) {
    throw new RangeError(`pushdata length out of range: ${data.length}`);
  }
  const out = new Uint8Array(1 + data.length);
  out[0] = data.length;
  out.set(data, 1);
  return out;
}

const RECLAIM_ID_LENGTH = 32;
/** The time-based relative-locktime flag of the script engine. */
const SEQUENCE_LOCKTIME_TYPE_FLAG = 1 << 27;

/** The CSV constant for a reclaim window of `seconds`: time-based, 10s units. */
export function reclaimCsvValue(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new RangeError(`reclaim window must be a positive integer, got ${seconds}`);
  }
  return Math.floor(seconds / 10) | SEQUENCE_LOCKTIME_TYPE_FLAG;
}

function concatBytes(parts: ReadonlyArray<Uint8Array | number>): Uint8Array {
  const arrays = parts.map((p) => (typeof p === 'number' ? Uint8Array.of(p) : p));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** The shared IF/ELSE template around a type-gated IF branch. */
function reclaimScript(ifBranch: Uint8Array, csvValue: number): Uint8Array {
  const csv = new Uint8Array(4);
  new DataView(csv.buffer).setUint32(0, csvValue, true);
  return concatBytes([
    OP_IF,
    ifBranch,
    OP_ELSE,
    push(csv),
    OP_CSV,
    OP_DROP,
    OP_OUTPUTDATA,
    push(Uint8Array.of(0)),
    push(Uint8Array.of(RECLAIM_ID_LENGTH)),
    OP_SUBSTR,
    OP_OVER,
    OP_HASH256,
    OP_EQUALVERIFY,
    OP_CHECKSIG,
    OP_ENDIF,
  ]);
}

/**
 * The freeze-output script: IF = only the conversion service (holder of the
 * lock key) may spend, and only inside a TX_TYPE_DOWNGRADE — this keeps
 * grief-pinning out; ELSE = the user reclaims after the freeze window.
 */
export function freezeScript(lockPubkey: Uint8Array, freezeSeconds: number): Uint8Array {
  const ifBranch = concatBytes([OP_7, OP_TX_TYPE, OP_EQUALVERIFY, push(lockPubkey), OP_CHECKSIG]);
  return reclaimScript(ifBranch, reclaimCsvValue(freezeSeconds));
}

/**
 * The downgrade-output script: IF = anyone may spend in a TX_TYPE_BURN, no
 * signature (correctness comes from the burn's SPV proof, not a key); ELSE =
 * the user reclaims after the output window if the BTC payment never came.
 */
export function downgradeScript(outputSeconds: number): Uint8Array {
  const ifBranch = concatBytes([OP_6, OP_TX_TYPE, OP_EQUALVERIFY, OP_1]);
  return reclaimScript(ifBranch, reclaimCsvValue(outputSeconds));
}

/** scripthash of a freeze/downgrade script (hash160 — both are classical). */
export function reclaimScripthash(script: Uint8Array): Uint8Array {
  return hash160(script);
}

/**
 * The freeze output's `data`: [hash256(reclaim pubkey)][btc scriptPubKey].
 * The pubkey is normally the key of the transaction's FIRST input (the
 * node's convention) — then a restored wallet can rediscover its freezes by
 * matching this prefix against its own keys, with no extra state.
 */
export function freezeOutputData(reclaimPubkey: Uint8Array, btcScriptPubKey: Uint8Array): Uint8Array {
  if (btcScriptPubKey.length === 0) {
    throw new RangeError('freezeOutputData: empty BTC scriptPubKey');
  }
  return concatBytes([hash256(reclaimPubkey), btcScriptPubKey]);
}

/** The reclaim_id (leading 32 bytes of the output data) for a pubkey. */
export function reclaimIdFor(pubkey: Uint8Array): Uint8Array {
  return hash256(pubkey);
}

/** Build the freeze output itself. */
export function buildFreezeOutput(
  valueSat: bigint,
  freezeScripthash: Uint8Array,
  reclaimPubkey: Uint8Array,
  btcScriptPubKey: Uint8Array,
): TxOutput {
  return {
    value: valueSat,
    scripthash: freezeScripthash,
    data: freezeOutputData(reclaimPubkey, btcScriptPubKey),
  };
}

/**
 * Sign ONE reclaim input (the ELSE branch of a freeze/downgrade output) in a
 * standard transaction. The siglist is [signature, pubkey, <empty>]: OP_IF
 * pops the empty element as FALSE and takes the ELSE branch; the revealed
 * script rides along as the input's redeem script. Other inputs are signed
 * separately (signTransaction for ordinary ones).
 */
export async function signReclaimInput(
  tx: Transaction,
  signer: SigningInput,
  redeemScript: Uint8Array,
): Promise<Transaction> {
  if (tx.txType !== TX_TYPE_STANDARD) {
    throw new RangeError('A user reclaim is a standard transaction');
  }
  if (signer.inputIndex < 0 || signer.inputIndex >= tx.inputs.length) {
    throw new RangeError(`Reclaim signer references missing input ${signer.inputIndex}`);
  }
  const digest = sighash(tx, SIGHASH.ALL);
  const rawSig = await signWithAlgorithm(digest, signer.privateKey, signer.algo);
  const siglist = [
    encodeSiglistEntry(SIGHASH.ALL, signer.algo, rawSig),
    signer.publicKey,
    new Uint8Array(0),
  ];
  const inputs: TxInput[] = tx.inputs.map((input, i) =>
    i === signer.inputIndex ? { ...input, siglist, redeemScript } : input,
  );
  return { ...tx, inputs };
}
