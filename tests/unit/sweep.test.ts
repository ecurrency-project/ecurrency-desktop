import type { AddressInfo, Utxo } from '@qbitcoin/chain'
import { addressFromPubkey, encodeWif, fromHex, getPublicKey, scriptP2PK, toHex } from '@qbitcoin/crypto'
import { describe, expect, it } from 'vitest'
import { importedKeyFromStored, type ImportedKey } from '../../src/main/wallet/keyWallet'
import { createSweepSession, type SweepBackend } from '../../src/main/wallet/sweep'

// A real ECDSA key so the session derives, signs and serializes for real —
// only the chain is faked.
const PRIV = fromHex('0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d')
const WIF = encodeWif(PRIV, 'mainnet')
const RECIPIENT = addressFromPubkey(getPublicKey(fromHex('11'.repeat(32))), 'ecdsa', 'mainnet')

async function makeKey(): Promise<ImportedKey> {
  return importedKeyFromStored({ wif: WIF, algo: 'ecdsa', address: '' }, 'mainnet')
}

const ZERO = { fundedTxCount: 0, fundedSum: 0n, spentTxCount: 0, spentSum: 0n }

function backend(key: ImportedKey, utxos: readonly Utxo[], onBroadcast?: (hex: string) => void): SweepBackend {
  const funded = utxos.reduce((s, u) => s + u.value, 0n)
  return {
    getBlockchainInfo: async () => ({ tipHeight: 1000, tipHash: 'hash', network: 'mainnet' }),
    getAddressInfo: async (address: string): Promise<AddressInfo> =>
      address === key.address
        ? { address, chain: { fundedTxCount: utxos.length, fundedSum: funded, spentTxCount: 0, spentSum: 0n }, mempool: ZERO, tokens: {} }
        : { address, chain: ZERO, mempool: ZERO, tokens: {} },
    getAddressTransactions: async () => [],
    getTransaction: async (txid: string) => {
      throw new Error(`no tx ${txid}`)
    },
    getTransactionHex: async () => '00',
    getFeeEstimates: async () => ({ '1': 12, '6': 5, '144': 1 }),
    getTokenInfo: async (id: string) => ({ id, decimals: 6 }),
    listUnspent: async (address: string) => (address === key.address ? [...utxos] : []),
    broadcastTransaction: async (rawHex: string) => {
      onBroadcast?.(rawHex)
      return { txid: 'broadcast-accepted' }
    },
  }
}

const utxo = (n: number, value: bigint): Utxo => ({ txid: String(n).padStart(2, '0').repeat(32).slice(0, 64), vout: n, value, status: { confirmed: true, blockHeight: 900 } })

describe('createSweepSession', () => {
  it('scans the balance of exactly the key address', async () => {
    const key = await makeKey()
    const session = createSweepSession(backend(key, [utxo(1, 60_000n), utxo(2, 40_000n)]), key, 'mainnet')
    expect(session.address).toBe(key.address)
    expect((await session.scanBalance()).balanceAtomic).toBe('100000')
  })

  it('sweeps everything with send-max: no change, signed with the key, broadcast', async () => {
    const key = await makeKey()
    let sent: string | null = null
    const session = createSweepSession(
      backend(key, [utxo(1, 60_000n), utxo(2, 40_000n)], (hex) => {
        sent = hex
      }),
      key,
      'mainnet',
    )
    const preview = await session.send.buildSend(RECIPIENT, 0n, undefined, true)
    expect(preview.changeAtomic).toBe('0')
    expect(BigInt(preview.amountAtomic) + BigInt(preview.feeAtomic)).toBe(100_000n)
    expect(preview.signature).toBe('ECDSA')

    const result = await session.send.confirmSend()
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(sent).not.toBeNull()
    // Every input carries the key's P2PK redeem script.
    expect(sent).toContain(toHex(scriptP2PK(key.publicKey)))
  })

  it('returns change from a partial send (to the key itself, by construction)', async () => {
    const key = await makeKey()
    const session = createSweepSession(backend(key, [utxo(1, 60_000n), utxo(2, 40_000n)]), key, 'mainnet')
    const preview = await session.send.buildSend(RECIPIENT, 30_000n, undefined, false)
    // amount + fee + change account for the selected inputs exactly.
    expect(BigInt(preview.amountAtomic)).toBe(30_000n)
    expect(BigInt(preview.amountAtomic) + BigInt(preview.feeAtomic) + BigInt(preview.changeAtomic)).toBe(BigInt(preview.totalAtomic) + BigInt(preview.changeAtomic))
    expect(BigInt(preview.changeAtomic)).toBeGreaterThan(0n)
  })

  it('dispose wipes the key and drops any held draft', async () => {
    const key = await makeKey()
    const session = createSweepSession(backend(key, [utxo(1, 60_000n)]), key, 'mainnet')
    await session.send.buildSend(RECIPIENT, 0n, undefined, true)
    session.dispose()
    expect(key.privateKey.every((b) => b === 0)).toBe(true)
    await expect(session.send.confirmSend()).rejects.toThrow(/No transaction to confirm/)
  })
})
