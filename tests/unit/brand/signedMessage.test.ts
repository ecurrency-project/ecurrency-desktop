import { describe, expect, it } from 'vitest'
import { fromHex, getPublicKey, toHex } from '@qbtc/crypto'
import { signedMessageDigest, signedMessagePreimage, signMessage, verifyMessage } from '../../../src/main/brand/crypto'
import { PROFILE } from '../../../src/main/brand/profile'

// The canonical eCurrency signed-message format under the brand's magic:
// preimage = varstr(MAGIC) || varstr(utf8(message)), digest = hash256(preimage).
// Goldens are frozen — dApps verify against them from the returned pubkey.

// Fixed test key: private bytes 0x01..0x20 (deterministic ECDSA → stable sig).
const PRIV = (() => {
  const k = new Uint8Array(32)
  for (let i = 0; i < 32; i++) k[i] = i + 1
  return k
})()
const PUB = getPublicKey(PRIV)
const MSG = 'Hello, eCurrency!'

describe('signed message format', () => {
  it('domain-separates from transactions (preimage starts with 0x1a)', () => {
    // The 26-byte magic → varint(26) = 0x1a, which is not a valid tx_type
    // (1..4), so a message preimage can never be a transaction sighash preimage.
    expect(PROFILE.messageMagic.length).toBe(26)
    expect(signedMessagePreimage(MSG)[0]).toBe(0x1a)
  })

  it('digest is the golden double-SHA256 of the preimage', () => {
    expect(toHex(signedMessageDigest(MSG))).toBe('edf829cc0831953eb4aec42eed9fbde92ec61a8bac32cd317192f8a77c284f0f')
    expect(toHex(signedMessageDigest(''))).toBe('ad2ed0f215d1f3ba28d444ceb5507b59dfc155b85f2c1427716c2886e25a42c5')
  })

  it('signs deterministically (golden ECDSA / DER vector)', async () => {
    const sig = await signMessage(MSG, PRIV, 'ecdsa')
    expect(toHex(sig)).toBe(
      '304402200f4ab74c6926328359854b11c5c0ebbf76d896120372faac4e1c2f2b65b09c77' +
        '02204ff84a334f04fe672c9ebdf3a42c17fd7fdd1a2e32b208bf8f1f584f703ffb7a',
    )
  })

  it('round-trips: verifyMessage accepts a fresh signature', async () => {
    const sig = await signMessage(MSG, PRIV, 'ecdsa')
    expect(await verifyMessage(MSG, sig, PUB, 'ecdsa')).toBe(true)
  })

  it('rejects a tampered message, wrong key, bad sig, unsupported algo', async () => {
    const sig = await signMessage(MSG, PRIV, 'ecdsa')
    expect(await verifyMessage(`${MSG}!`, sig, PUB, 'ecdsa')).toBe(false)
    const otherPriv = new Uint8Array(32)
    otherPriv[31] = 9
    expect(await verifyMessage(MSG, sig, getPublicKey(otherPriv), 'ecdsa')).toBe(false)
    expect(await verifyMessage(MSG, fromHex('deadbeef'), PUB, 'ecdsa')).toBe(false)
    expect(await verifyMessage(MSG, sig, PUB, 'schnorr')).toBe(false)
  })
})
