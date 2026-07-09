import type { AddressInfo, Utxo } from '@qbitcoin/chain'
import { describe, expect, it } from 'vitest'
import { gatherFromActive, gatherSpendable, type SpendableBackend } from '../../src/main/wallet/spendable'

const ZERO = { fundedTxCount: 0, fundedSum: 0n, spentTxCount: 0, spentSum: 0n }
const activeInfo = (address: string): AddressInfo => ({
  address,
  chain: { fundedTxCount: 1, fundedSum: 100n, spentTxCount: 0, spentSum: 0n },
  mempool: ZERO,
  tokens: {},
})
const emptyInfo = (address: string): AddressInfo => ({ address, chain: ZERO, mempool: ZERO, tokens: {} })

const derive = (chain: 0 | 1, index: number): string => `addr-${chain}-${index}`

function backend(utxos: Record<string, Utxo[]>, active: ReadonlySet<string>): SpendableBackend {
  return {
    getAddressInfo: async (address) => (active.has(address) ? activeInfo(address) : emptyInfo(address)),
    listUnspent: async (address) => utxos[address] ?? [],
  }
}

describe('gatherSpendable', () => {
  it('tags each UTXO with its address coords, including token UTXOs', async () => {
    const b = backend(
      {
        'addr-0-0': [
          { txid: 'aa', vout: 0, value: 100n, status: { confirmed: true } },
          { txid: 'bb', vout: 1, value: 0n, status: { confirmed: true }, tokenId: 'tok', tokenAmount: 5n },
        ],
      },
      new Set(['addr-0-0']),
    )
    const spendable = await gatherSpendable(derive, b, { receive: 0, change: 0 })
    expect(spendable).toHaveLength(2)
    const native = spendable.find((u) => u.txid === 'aa')!
    const token = spendable.find((u) => u.txid === 'bb')!
    expect(native).toMatchObject({ value: 100n, chain: 0, index: 0, algo: 'ecdsa', address: 'addr-0-0', confirmed: true })
    expect(native.tokenId).toBeUndefined()
    expect(token).toMatchObject({ value: 0n, tokenId: 'tok', tokenAmount: 5n, algo: 'ecdsa', address: 'addr-0-0' })
  })

  it('gathers extra branches (e.g. Falcon) with an async deriver and tags their algo', async () => {
    const pqDerive = async (chain: 0 | 1, index: number): Promise<string> => `pq-${chain}-${index}`
    const b = backend(
      {
        'addr-0-0': [{ txid: 'aa', vout: 0, value: 100n, status: { confirmed: true } }],
        'pq-0-0': [{ txid: 'cc', vout: 0, value: 50n, status: { confirmed: true } }],
      },
      new Set(['addr-0-0', 'pq-0-0']),
    )
    const spendable = await gatherSpendable(derive, b, { receive: 0, change: 0 }, [
      { algo: 'falcon512', derive: pqDerive, floors: { receive: 0, change: 0 } },
    ])
    expect(spendable).toHaveLength(2)
    expect(spendable.find((u) => u.txid === 'aa')).toMatchObject({ algo: 'ecdsa', address: 'addr-0-0' })
    expect(spendable.find((u) => u.txid === 'cc')).toMatchObject({ algo: 'falcon512', address: 'pq-0-0', value: 50n })
  })

  it('carries the branch scheme onto its UTXOs (extra branch with a scheme id)', async () => {
    const legacyDerive = async (chain: 0 | 1, index: number): Promise<string> => `legacy-${chain}-${index}`
    const b = backend(
      {
        'addr-0-0': [{ txid: 'aa', vout: 0, value: 100n, status: { confirmed: true } }],
        'legacy-0-0': [{ txid: 'dd', vout: 0, value: 7n, status: { confirmed: true } }],
      },
      new Set(['addr-0-0', 'legacy-0-0']),
    )
    const spendable = await gatherSpendable(derive, b, { receive: 0, change: 0 }, [
      { algo: 'ecdsa', scheme: 'fake-v1', derive: legacyDerive, floors: { receive: 0, change: 0 } },
    ])
    expect(spendable.find((u) => u.txid === 'dd')).toMatchObject({ scheme: 'fake-v1', algo: 'ecdsa' })
    expect(spendable.find((u) => u.txid === 'aa')!.scheme).toBeUndefined()
  })
})

describe('gatherFromActive', () => {
  it('keeps the scheme tag of each active address on its UTXOs', async () => {
    const b = backend({ 'v1-0-2': [{ txid: 'ee', vout: 1, value: 42n, status: { confirmed: false } }] }, new Set(['v1-0-2']))
    const out = await gatherFromActive([{ address: 'v1-0-2', chain: 0, index: 2, algo: 'ecdsa', scheme: 'fake-v1' }], b)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ txid: 'ee', scheme: 'fake-v1', chain: 0, index: 2, algo: 'ecdsa', confirmed: false })
  })
})
