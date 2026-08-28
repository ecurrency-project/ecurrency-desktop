import { afterEach, describe, expect, it } from 'vitest'
import {
  SchnorrDisabledError,
  addressFromPubkey,
  encodeWif,
  fromHex,
  getPublicKey,
  schnorrGetPublicKey,
  scriptP2PK,
  setSchnorrEnabled,
  toHex,
} from '@qbitcoin/crypto'
import type { Algo, UnsignedTx } from '../../src/main/wallet/buildTx'
import {
  createKeyAddressSource,
  importedKeyFromStored,
  inspectWifKey,
  keyReceiveOps,
  signUnsignedTxWithKey,
  type ImportedKey,
} from '../../src/main/wallet/keyWallet'

// The canonical Bitcoin wiki key — a fine fixture since the WIF format is
// byte-compatible (0x80, no compression flag).
const PRIV = fromHex('0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d')
const WIF = encodeWif(PRIV, 'mainnet')

const unsignedWith = (algo: Algo): UnsignedTx => ({
  inputs: [
    { prevTxid: 'aa'.repeat(32), vout: 0, valueAtomic: '5000', account: 0, chain: 0, index: 0, algo },
    { prevTxid: 'bb'.repeat(32), vout: 1, valueAtomic: '7000', account: 0, chain: 0, index: 0, algo },
  ],
  outputs: [{ valueAtomic: '11000', scripthash: 'cc'.repeat(20) }],
})

describe('importedKeyFromStored', () => {
  it('materializes an ECDSA key with its address', async () => {
    const key = await importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: '' }, 'mainnet')
    expect(key.algo).toBe('ecdsa')
    expect(toHex(key.privateKey)).toBe(toHex(PRIV))
    expect(key.address).toBe(addressFromPubkey(getPublicKey(PRIV), 'ecdsa', 'mainnet'))
  })

  it('materializes a Schnorr key with a different (x-only) address', async () => {
    const key = await importedKeyFromStored({ wif: WIF, algo: 'schnorr', address: '' }, 'mainnet')
    expect(key.publicKey).toHaveLength(32)
    expect(key.address).toBe(addressFromPubkey(schnorrGetPublicKey(PRIV), 'schnorr', 'mainnet'))
    const ecdsa = await importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: '' }, 'mainnet')
    expect(key.address).not.toBe(ecdsa.address)
  })

  it('verifies the stored address and refuses a mismatch', async () => {
    await expect(importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: 'ECwrongaddress' }, 'mainnet')).rejects.toThrow(/address mismatch/)
    // …and accepts the correct one.
    const good = await importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: '' }, 'mainnet')
    await expect(importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: good.address }, 'mainnet')).resolves.toBeDefined()
  })

  it('refuses an algorithm the payload does not admit', async () => {
    await expect(importedKeyFromStored({ wif: WIF, algo: 'falcon512', address: '' }, 'mainnet')).rejects.toThrow(/cannot be used/)
  })
})

describe('key wallet address source + receive ops', () => {
  const getKey = async (): Promise<ImportedKey> => importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: '' }, 'mainnet')

  it('exposes exactly one list branch with the single address', async () => {
    const branches = await createKeyAddressSource(getKey).branches()
    expect(branches).toHaveLength(1)
    const branch = branches[0]!
    expect(branch.kind).toBe('list')
    expect(branch.algo).toBe('ecdsa')
    if (branch.kind === 'list') {
      expect(branch.addresses).toEqual([{ chain: 0, index: 0, address: (await getKey()).address }])
    }
  })

  it('receive ops always return the same single address', async () => {
    const ops = keyReceiveOps(getKey)
    const address = (await getKey()).address
    expect(await ops.getReceiveAddress()).toBe(address)
    expect(await ops.getNewReceiveAddress()).toBe(address) // no derivation to advance
    expect(await ops.listReceiveAddresses()).toEqual([{ address, index: 0, current: true }])
  })
})

describe('signUnsignedTxWithKey', () => {
  afterEach(() => setSchnorrEnabled(false))

  it('signs every input with the imported ECDSA key (deterministic tx)', async () => {
    const key = await importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: '' }, 'mainnet')
    const a = await signUnsignedTxWithKey(unsignedWith('ecdsa'), key, 'mainnet')
    const b = await signUnsignedTxWithKey(unsignedWith('ecdsa'), key, 'mainnet')
    expect(a.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(a.txid).toBe(b.txid) // RFC6979 ECDSA — fully deterministic
    // The P2PK redeem script for the key's pubkey is attached to the inputs.
    expect(a.rawHex).toContain(toHex(scriptP2PK(key.publicKey)))
  })

  it('does NOT wipe the session-cached key after signing', async () => {
    const key = await importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: '' }, 'mainnet')
    await signUnsignedTxWithKey(unsignedWith('ecdsa'), key, 'mainnet')
    expect(key.privateKey.some((b) => b !== 0)).toBe(true)
    expect(toHex(key.privateKey)).toBe(toHex(PRIV))
  })

  it('refuses an input whose algorithm does not match the key', async () => {
    const key = await importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: '' }, 'mainnet')
    await expect(signUnsignedTxWithKey(unsignedWith('falcon512'), key, 'mainnet')).rejects.toThrow(/expects a falcon512 key/)
  })

  it('signs with a Schnorr key only when the feature flag is on', async () => {
    const key = await importedKeyFromStored({ wif: WIF, algo: 'schnorr', address: '' }, 'mainnet')
    await expect(signUnsignedTxWithKey(unsignedWith('schnorr'), key, 'mainnet')).rejects.toThrow(SchnorrDisabledError)
    setSchnorrEnabled(true)
    const signed = await signUnsignedTxWithKey(unsignedWith('schnorr'), key, 'mainnet')
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.rawHex).toContain(toHex(scriptP2PK(key.publicKey)))
  })
})

describe('inspectWifKey', () => {
  it('offers ECDSA only by default (Schnorr behind the flag)', async () => {
    const res = await inspectWifKey(WIF, 'mainnet')
    expect(res.candidates).toEqual(['ecdsa'])
    expect(res.addresses.ecdsa).toBe(addressFromPubkey(getPublicKey(PRIV), 'ecdsa', 'mainnet'))
    expect(res.addresses.schnorr).toBeUndefined()
  })

  it('offers Schnorr too when included, with its own address', async () => {
    const res = await inspectWifKey(WIF, 'mainnet', { includeSchnorr: true })
    expect(res.candidates).toEqual(['ecdsa', 'schnorr'])
    expect(res.addresses.schnorr).toBe(addressFromPubkey(schnorrGetPublicKey(PRIV), 'schnorr', 'mainnet'))
    expect(res.addresses.schnorr).not.toBe(res.addresses.ecdsa)
  })

  it('propagates WIF validation errors (wrong network)', async () => {
    const testnetWif = encodeWif(PRIV, 'testnet')
    await expect(inspectWifKey(testnetWif, 'mainnet')).rejects.toThrow(/testnet/)
  })
})
