import { activeScheme, decodeAddress, deriveFalconKeypair, derivePath, nativePath, encodeTokenTransfer, masterKeyFromSeed, mnemonicToSeed, sighash, toHex, TX_TYPE_TOKENS, verifySiglistEntry } from '@qbitcoin/crypto'
import { describe, expect, it } from 'vitest'
import type { UnsignedTx } from '../../src/main/wallet/buildTx'
import { buildSignedTransaction, signUnsignedTx, toCryptoTransaction } from '../../src/main/wallet/signTx'

const MASTER = masterKeyFromSeed(mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))
const RECIPIENT = 'bqRS2bzC6BuG9Qm7hyMXJYzy295UEgZZCEX'

function unsigned(): UnsignedTx {
  return {
    inputs: [{ prevTxid: 'ab'.repeat(32), vout: 0, valueAtomic: '5000000', account: 0, chain: 0, index: 0, algo: 'ecdsa' }],
    outputs: [{ valueAtomic: '1000000', scripthash: toHex(decodeAddress(RECIPIENT).scripthash) }],
  }
}

describe('signUnsignedTx', () => {
  it('produces a signature that verifies against the sighash and signing key', async () => {
    const u = unsigned()
    const signed = await buildSignedTransaction(u, MASTER)
    const entry = signed.inputs[0]!.siglist![0]!
    const digest = sighash(toCryptoTransaction(u))
    const pub = derivePath(MASTER, nativePath(0, 0, 0)).publicKey!
    expect(await verifySiglistEntry(entry, digest, pub)).toBe(true)
  })

  it('serializes deterministically with a 32-byte txid, embedding inputs and outputs', async () => {
    const u = unsigned()
    const a = await signUnsignedTx(u, MASTER)
    const b = await signUnsignedTx(u, MASTER)
    expect(a.rawHex).toBe(b.rawHex) // RFC-6979 deterministic ECDSA
    expect(a.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(a.rawHex).toContain('ab'.repeat(32)) // input txid, verbatim
    expect(a.rawHex).toContain(u.outputs[0]!.scripthash) // recipient scripthash
  })

  it('signs a Falcon-512 (post-quantum) input with a verifiable signature', async () => {
    const u: UnsignedTx = {
      inputs: [{ prevTxid: 'cd'.repeat(32), vout: 0, valueAtomic: '1000000', account: 0, chain: 0, index: 0, algo: 'falcon512' }],
      outputs: [{ valueAtomic: '900000', scripthash: toHex(decodeAddress(RECIPIENT).scripthash) }],
    }
    const signed = await buildSignedTransaction(u, MASTER)
    const entry = signed.inputs[0]!.siglist![0]!
    const digest = sighash(toCryptoTransaction(u))
    const { publicKey } = await deriveFalconKeypair(MASTER, 0, 0, 0)
    expect(await verifySiglistEntry(entry, digest, publicKey)).toBe(true)
  })

  it('signs an input tagged with its scheme id on that scheme\'s path (same as active here)', async () => {
    // The registry has a single scheme on this branch, so tagging the input with
    // it must reproduce the untagged signature byte for byte (same path).
    const untagged = await signUnsignedTx(unsigned(), MASTER)
    const tagged: UnsignedTx = {
      ...unsigned(),
      inputs: unsigned().inputs.map((i) => ({ ...i, scheme: activeScheme().id })),
    }
    expect((await signUnsignedTx(tagged, MASTER)).rawHex).toBe(untagged.rawHex)
  })

  it('refuses an input with an unknown scheme id (never sign on a guessed path)', async () => {
    const u: UnsignedTx = {
      ...unsigned(),
      inputs: unsigned().inputs.map((i) => ({ ...i, scheme: 'no-such-scheme' })),
    }
    await expect(signUnsignedTx(u, MASTER)).rejects.toThrow(/Unknown derivation scheme/)
  })

  it('maps a token transfer to TX_TYPE_TOKENS with the wire token-id prefix, still signable', async () => {
    const tokenId = '8b'.repeat(32) // 32-byte token id (hex)
    const u: UnsignedTx = {
      tokenHash: tokenId,
      inputs: [{ prevTxid: 'ab'.repeat(32), vout: 0, valueAtomic: '5000000', account: 0, chain: 0, index: 0, algo: 'ecdsa' }],
      outputs: [
        { valueAtomic: '0', scripthash: toHex(decodeAddress(RECIPIENT).scripthash), data: toHex(encodeTokenTransfer(56753706n)) },
        { valueAtomic: '4999000', scripthash: toHex(decodeAddress(RECIPIENT).scripthash) }, // native fee change
      ],
    }
    const tx = toCryptoTransaction(u)
    expect(tx.txType).toBe(TX_TYPE_TOKENS)
    expect(toHex(tx.tokenHash!)).toBe(tokenId)
    expect(toHex(tx.outputs[0]!.data!)).toBe('012afe610300000000')

    const { rawHex } = await signUnsignedTx(u, MASTER)
    // Wire form: type byte 04, then varstr(0x20 || token_id).
    expect(rawHex.startsWith(`0420${tokenId}`)).toBe(true)

    // The sighash omits that prefix, so the input still signs and verifies.
    const entry = (await buildSignedTransaction(u, MASTER)).inputs[0]!.siglist![0]!
    const pub = derivePath(MASTER, nativePath(0, 0, 0)).publicKey!
    expect(await verifySiglistEntry(entry, sighash(toCryptoTransaction(u)), pub)).toBe(true)
  })
})
