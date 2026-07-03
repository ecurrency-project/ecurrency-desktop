import { describe, expect, it } from 'vitest'
import { CoinService } from '../../src/main/wallet/CoinService'
import { CoinMetaStore } from '../../src/main/wallet/coinMeta'
import type { GatheredUtxo } from '../../src/main/wallet/spendable'

function utxo(txid: string, vout: number, value: bigint, over: Partial<GatheredUtxo> = {}): GatheredUtxo {
  return { txid, vout, value, chain: 0, index: 0, algo: 'ecdsa', address: `addr-${txid}`, confirmed: true, blockHeight: 900, ...over }
}

function harness(utxos: GatheredUtxo[]) {
  let blob: string | null = null
  const store = { read: async () => blob, write: async (b: string) => { blob = b } }
  const sealer = { sealData: async (p: string) => p, openData: async (b: string) => b }
  const meta = new CoinMetaStore(store, sealer)
  const svc = new CoinService({ gather: async () => utxos, tipHeight: async () => 1000, meta })
  return { svc, readBlob: () => blob }
}

describe('CoinService', () => {
  it('lists UTXOs with confirmations and metadata defaults', async () => {
    const { svc } = harness([utxo('aa', 0, 100n, { blockHeight: 991 })])
    const list = await svc.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ outpoint: 'aa:0', address: 'addr-aa', valueAtomic: '100', confirmations: 10, frozen: false })
    expect(list[0]!.label).toBeUndefined()
  })

  it('applies and persists a label and freeze', async () => {
    const { svc } = harness([utxo('aa', 0, 100n)])
    await svc.setLabel('aa:0', 'savings')
    await svc.setFrozen('aa:0', true)
    expect((await svc.list())[0]).toMatchObject({ label: 'savings', frozen: true })
  })

  it('clears the entry when label is emptied and unfrozen', async () => {
    const { svc, readBlob } = harness([utxo('aa', 0, 100n)])
    await svc.setLabel('aa:0', 'x')
    await svc.setFrozen('aa:0', true)
    await svc.setLabel('aa:0', '   ') // empty → clears label
    await svc.setFrozen('aa:0', false) // → clears frozen
    const view = (await svc.list())[0]!
    expect(view.label).toBeUndefined()
    expect(view.frozen).toBe(false)
    expect(JSON.parse(readBlob() ?? '{}')).toEqual({}) // entry removed entirely
  })

  it('reports 0 confirmations for an unconfirmed UTXO', async () => {
    const { svc } = harness([utxo('bb', 1, 50n, { confirmed: false, blockHeight: undefined })])
    expect((await svc.list())[0]!.confirmations).toBe(0)
  })
})
