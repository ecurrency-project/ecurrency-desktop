import { activeScheme, masterKeyFromSeed, mnemonicToSeed } from '@qbitcoin/crypto'
import { describe, expect, it } from 'vitest'
import { AddressService, type WalletVault } from '../../src/main/wallet/AddressService'
import { WalletMetaStore } from '../../src/main/wallet/meta'

const MASTER = masterKeyFromSeed(mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))

// In-memory blob store + identity sealer. The real sealing is the Vault's job
// (covered by the crypto package); here we exercise index bookkeeping + the
// derivation wiring.
function fakes() {
  let blob: string | null = null
  const store = {
    read: async () => blob,
    write: async (b: string) => {
      blob = b
    },
  }
  const sealer = { sealData: async (p: string) => p, openData: async (b: string) => b }
  const vault: WalletVault = { getMasterKey: () => Promise.resolve(MASTER), on: () => () => {} }
  const service = new AddressService(vault, new WalletMetaStore(store, sealer), 'mainnet')
  return { service, readBlob: () => blob }
}

describe('AddressService', () => {
  it('returns a stable receive address at index 0 by default', async () => {
    const { service } = fakes()
    const a = await service.getReceiveAddress()
    const b = await service.getReceiveAddress()
    expect(a).toBe(b)
    expect(a.startsWith('bq')).toBe(true)
  })

  it('advances and persists the index on a new address', async () => {
    const { service, readBlob } = fakes()
    const first = await service.getReceiveAddress()
    const second = await service.getNewReceiveAddress()
    expect(second).not.toBe(first)
    // Indices are persisted per scheme (v2 meta); fresh addresses advance the ACTIVE one.
    expect(JSON.parse(readBlob()!)).toEqual({
      version: 2,
      schemes: { [activeScheme().id]: { receiveIndex: 1, changeIndex: 0, pqReceiveIndex: 0, pqChangeIndex: 0 } },
    })
    // The current receive address is now the advanced one.
    expect(await service.getReceiveAddress()).toBe(second)
  })

  it('lists every surfaced receive address with the current one flagged', async () => {
    const { service } = fakes()
    const first = await service.getReceiveAddress()
    const second = await service.getNewReceiveAddress()
    expect(await service.listReceiveAddresses()).toEqual([
      { address: first, index: 0, current: false },
      { address: second, index: 1, current: true },
    ])
  })

  it('refuses schnorr — HD wallets have no Schnorr branch', async () => {
    const { service } = fakes()
    await expect(service.getReceiveAddress('schnorr')).rejects.toThrow(/no Schnorr branch/)
    await expect(service.getNewReceiveAddress('schnorr')).rejects.toThrow(/no Schnorr branch/)
    await expect(service.listReceiveAddresses('schnorr')).rejects.toThrow(/no Schnorr branch/)
  })
})
