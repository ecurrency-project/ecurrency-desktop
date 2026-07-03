import { derivePath, encodeTokenTransfer, masterKeyFromSeed, mnemonicToSeed, SIGHASH, sighash, toHex, TX_TYPE_TOKENS, verifySiglistEntry } from '@qbtc/crypto'
import { activeScheme, decodeAddress, deriveFalconKeypair, nativePath, sighashCommitsTokenId } from '../../src/main/brand/crypto'
import { describe, expect, it } from 'vitest'
import type { UnsignedTx } from '../../src/main/wallet/buildTx'
import { buildSignedTransaction, signUnsignedTx, toCryptoTransaction } from '../../src/main/wallet/signTx'

const MASTER = masterKeyFromSeed(mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))
const RECIPIENT = 'ECQFhYJWVgDyNdsFWdpeG5w2G5it7Cwh4Gd'

function unsigned(): UnsignedTx {
  return {
    inputs: [{ prevTxid: 'ab'.repeat(32), vout: 0, valueAtomic: '5000000', account: 0, chain: 0, index: 0, algo: 'ecdsa' }],
    outputs: [{ valueAtomic: '1000000', scripthash: toHex(decodeAddress(RECIPIENT).scripthash) }],
  }
}

describe('signUnsignedTx', () => {
  it('produces a signature that verifies against the sighash and signing key', async () => {
    const u = unsigned()
    const signed = await buildSignedTransaction(u, MASTER, 'mainnet')
    const entry = signed.inputs[0]!.siglist![0]!
    const digest = sighash(toCryptoTransaction(u))
    const pub = derivePath(MASTER, nativePath(0, 0, 'mainnet', 0)).publicKey!
    expect(await verifySiglistEntry(entry, digest, pub)).toBe(true)
  })

  it('serializes deterministically with a 32-byte txid, embedding inputs and outputs', async () => {
    const u = unsigned()
    const a = await signUnsignedTx(u, MASTER, 'mainnet')
    const b = await signUnsignedTx(u, MASTER, 'mainnet')
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
    const signed = await buildSignedTransaction(u, MASTER, 'mainnet')
    const entry = signed.inputs[0]!.siglist![0]!
    const digest = sighash(toCryptoTransaction(u))
    const { publicKey } = await deriveFalconKeypair(MASTER, 0, 0, 0, 'mainnet')
    expect(await verifySiglistEntry(entry, digest, publicKey)).toBe(true)
  })

  it('signs an input tagged with its scheme id on that scheme\'s path (same as active here)', async () => {
    // The registry has a single scheme on this branch, so tagging the input with
    // it must reproduce the untagged signature byte for byte (same path).
    const untagged = await signUnsignedTx(unsigned(), MASTER, 'mainnet')
    const tagged: UnsignedTx = {
      ...unsigned(),
      inputs: unsigned().inputs.map((i) => ({ ...i, scheme: activeScheme().id })),
    }
    expect((await signUnsignedTx(tagged, MASTER, 'mainnet')).rawHex).toBe(untagged.rawHex)
  })

  it('refuses an input with an unknown scheme id (never sign on a guessed path)', async () => {
    const u: UnsignedTx = {
      ...unsigned(),
      inputs: unsigned().inputs.map((i) => ({ ...i, scheme: 'no-such-scheme' })),
    }
    await expect(signUnsignedTx(u, MASTER, 'mainnet')).rejects.toThrow(/Unknown derivation scheme/)
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

    const { rawHex } = await signUnsignedTx(u, MASTER, 'mainnet')
    // Wire form: type byte 04, then varstr(0x20 || token_id).
    expect(rawHex.startsWith(`0420${tokenId}`)).toBe(true)

    // The signature commits whichever token-sighash framing this build's
    // fork dictates for the signing moment — and NOT the opposite one.
    const entry = (await buildSignedTransaction(u, MASTER, 'mainnet')).inputs[0]!.siglist![0]!
    const pub = derivePath(MASTER, nativePath(0, 0, 'mainnet', 0)).publicKey!
    const verdict = sighashCommitsTokenId('mainnet')
    expect(await verifySiglistEntry(entry, sighash(toCryptoTransaction(u), SIGHASH.ALL, verdict), pub)).toBe(true)
    expect(await verifySiglistEntry(entry, sighash(toCryptoTransaction(u), SIGHASH.ALL, !verdict), pub)).toBe(false)
  })
})
