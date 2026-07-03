// Canonical signed-message format.
//
// The node has no `signmessage`/`verifymessage`, so we DEFINE the format and
// ship it here — canonical, tested, and verifiable by dApps from the
// returned pubkey.
//
//   preimage = varstr(MAGIC) || varstr(utf8(message))
//   digest   = hash256(preimage)                    // double-SHA256
//   sig      = sign(digest, key, algo)              // secp256k1 / Falcon-512
//
// BRAND FILE: MESSAGE_MAGIC is a brand value (signatures made under one
// brand's magic don't verify under another's — deliberate domain
// separation between chains).
//
// Domain separation from transactions: varstr(MAGIC) begins with
// varint(len(MAGIC)) — 25 here — which is not a valid tx_type (1..4) and the
// structure differs, so a signed message can never be mistaken for (or
// collide with) a transaction sighash. Any brand magic longer than 4 bytes
// keeps this property.

import type { Algorithm } from './constants';
import { encodeVarstr } from './encoding/varstr';
import { falcon512Verify } from './falcon512';
import { hash256 } from './hashes';
import { verify as secp256k1Verify } from './secp256k1';
import { signWithAlgorithm } from './signing';

/** Magic prefix (25 bytes) — Bitcoin's convention, brand-flavored. */
export const MESSAGE_MAGIC = 'QBitcoin Signed Message:\n';

const utf8 = new TextEncoder();

/** The bytes that get hashed: `varstr(MAGIC) || varstr(utf8(message))`. */
export function signedMessagePreimage(message: string): Uint8Array {
  const magic = encodeVarstr(utf8.encode(MESSAGE_MAGIC));
  const body = encodeVarstr(utf8.encode(message));
  const out = new Uint8Array(magic.length + body.length);
  out.set(magic, 0);
  out.set(body, magic.length);
  return out;
}

/** Domain-separated digest for a signed message. */
export function signedMessageDigest(message: string): Uint8Array {
  return hash256(signedMessagePreimage(message));
}

/** Sign a UTF-8 message → raw signature bytes for `algo` (DER for ECDSA). */
export async function signMessage(
  message: string,
  privateKey: Uint8Array,
  algo: Algorithm,
): Promise<Uint8Array> {
  return signWithAlgorithm(signedMessageDigest(message), privateKey, algo);
}

/** Verify a message signature against `publicKey`. Never throws — callers may
 *  pass adversarial input. */
export async function verifyMessage(
  message: string,
  signature: Uint8Array,
  publicKey: Uint8Array,
  algo: Algorithm,
): Promise<boolean> {
  try {
    const digest = signedMessageDigest(message);
    if (algo === 'ecdsa') return secp256k1Verify(signature, digest, publicKey);
    if (algo === 'falcon512') return await falcon512Verify(signature, digest, publicKey);
    return false; // schnorr / unknown not supported for messages
  } catch {
    return false;
  }
}
