import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from './encoding/hex';
import { getPublicKey } from './secp256k1';
import {
  MESSAGE_MAGIC,
  signMessage,
  signedMessageDigest,
  signedMessagePreimage,
  verifyMessage,
} from './signedMessage';

// Fixed test key: private bytes 0x01..0x20 (deterministic ECDSA → stable sig).
const PRIV = (() => {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = i + 1;
  return k;
})();
const PUB = getPublicKey(PRIV);
const MSG = 'Hello, chain!';

describe('signed message format', () => {
  it('domain-separates from transactions (preimage starts with 0x1a)', () => {
    // The 25-byte magic → varint(25) = 0x19, which is not a valid tx_type
    // (1..4), so a message preimage can never be a transaction sighash preimage.
    expect(MESSAGE_MAGIC.length).toBe(25);
    expect(signedMessagePreimage(MSG)[0]).toBe(0x19);
  });

  it('digest is the golden double-SHA256 of the preimage', () => {
    expect(toHex(signedMessageDigest(MSG))).toBe(
      'de998dafe328aefb1c7605baf1817241aa4fe9d871a75aa8f7c73c9310a8eae3',
    );
    expect(toHex(signedMessageDigest(''))).toBe(
      '46502ed3a2837ceab6ef44d9e7b0b643328b237a8c6c93dd2b314da55cc47cbb',
    );
  });

  it('signs deterministically (golden ECDSA / DER vector)', async () => {
    const sig = await signMessage(MSG, PRIV, 'ecdsa');
    expect(toHex(sig)).toBe(
      '304402200e6837dbb5d10a3e91001df70e6c815d6b53a06936e1a4943e40050b9ecaa434' +
        '022076b231756537fed009d2d4bef8c069207ddc4f525d2d02db1fc4614307c425e6',
    );
  });

  it('round-trips: verifyMessage accepts a fresh signature', async () => {
    const sig = await signMessage(MSG, PRIV, 'ecdsa');
    expect(await verifyMessage(MSG, sig, PUB, 'ecdsa')).toBe(true);
  });

  it('rejects a tampered message, wrong key, bad sig, unsupported algo', async () => {
    const sig = await signMessage(MSG, PRIV, 'ecdsa');
    expect(await verifyMessage(`${MSG}!`, sig, PUB, 'ecdsa')).toBe(false);
    const otherPriv = new Uint8Array(32);
    otherPriv[31] = 9;
    expect(await verifyMessage(MSG, sig, getPublicKey(otherPriv), 'ecdsa')).toBe(false);
    expect(await verifyMessage(MSG, fromHex('deadbeef'), PUB, 'ecdsa')).toBe(false);
    expect(await verifyMessage(MSG, sig, PUB, 'schnorr')).toBe(false);
  });
});
