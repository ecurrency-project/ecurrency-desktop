import { describe, expect, it } from 'vitest'
import { VaultOrchestrator, type AddressOps, type ChainOps, type CoinOps, type ContactOps, type MnemonicTools, type NodeOps, type SendOps, type SweepOps, type UpgradeOps, type VaultLike, type WalletOps } from '../../src/main/vault/orchestrator'
import type { VaultStatus } from '../../src/shared/protocol'

const SEED = 'SEED-MUST-NEVER-CROSS-THE-BRIDGE'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Stand-in for the real Vault. `seed` is the secret that must never appear in a
// bridge response. (Autolock is the Vault's own concern and is tested there.)
class FakeVault implements VaultLike {
  status: VaultStatus = 'empty'
  readonly seed = SEED
  getStatus(): VaultStatus {
    return this.status
  }
  create(_mnemonic: string, _password: string): void {
    this.status = 'unlocked'
  }
  unlock(password: string): void {
    if (password !== 'pw') throw new Error('bad password')
    this.status = 'unlocked'
  }
  lock(): void {
    this.status = 'locked'
  }
  destroy(): void {
    this.status = 'empty'
  }
  revealMnemonic(password: string): string {
    if (password !== 'pw') throw new Error('bad password')
    return MNEMONIC
  }
  changePassword(oldPassword: string, _newPassword: string): void {
    if (oldPassword !== 'pw') throw new Error('bad password')
  }
  activityPings = 0
  noteActivity(): void {
    this.activityPings++
  }
}

const TOOLS: MnemonicTools = {
  generateMnemonic: () => MNEMONIC,
  validateMnemonic: (phrase) => phrase.trim() === MNEMONIC,
}

const ADDRESSES: AddressOps = {
  getReceiveAddress: async () => 'EC_receive',
  getNewReceiveAddress: async () => 'EC_new',
  listReceiveAddresses: async () => [{ address: 'EC_receive', index: 0, current: true }],
}

const CHAIN: ChainOps = {
  getSummary: async () => ({ balanceAtomic: '0', tipHeight: 0, addressCount: 0 }),
  getHistory: async () => ({ items: [], hasMore: false }),
  estimateFee: async () => ({ fast: 1, medium: 1, slow: 1 }),
  listTokens: async () => [],
  setTxLabel: async () => {},
  getTxDetail: async (txid) => ({ txid, confirmations: 0, sizeBytes: 0, totalInAtomic: '0', totalOutAtomic: '0', feeAtomic: '0', inputs: [], outputs: [] }),
  getTxRaw: async (txid) => `raw:${txid}`,
  getSnapshot: async () => null,
}

const SEND: SendOps = {
  buildSend: async (recipient, amountAtomic) => ({
    recipient,
    amountAtomic: amountAtomic.toString(),
    feeAtomic: '200',
    changeAtomic: '0',
    totalAtomic: (amountAtomic + 200n).toString(),
    signature: 'ECDSA',
  }),
  maxSendable: async () => ({ amountAtomic: '900', feeAtomic: '100' }),
  buildTokenSend: async (tokenId, recipient, amount) => ({ recipient, tokenId, tokenAmountAtomic: amount.toString(), feeAtomic: '5', signature: 'ECDSA' }),
  confirmSend: async () => ({ txid: 'deadbeef' }),
}

const COIN_ROW = { outpoint: 'aa:0', address: 'ECx', valueAtomic: '100', confirmations: 3, algo: 'ecdsa' as const, frozen: false }
const COINS: CoinOps = {
  list: async () => [COIN_ROW],
  setLabel: async () => {},
  setFrozen: async () => {},
}

const CONTACTS: ContactOps = {
  list: async () => [{ name: 'Amy', address: 'ECamy' }],
  add: async () => {},
  remove: async () => {},
}

const WALLETS: WalletOps = {
  list: async () => [],
  add: async () => [],
  addSeed: async () => [],
  inspectKey: async () => ({ candidates: [], addresses: {} }),
  addKey: async () => [],
  restore: async () => 'unlocked',
  switch: async () => [],
  rename: async () => [],
  remove: async () => [],
  exportDescriptor: async () => 'watch-descriptor',
}

const SWEEP: SweepOps = {
  scan: async () => ({ address: 'ECkey', balanceAtomic: '5000' }),
  build: async () => ({ recipient: 'ECkey', amountAtomic: '4000', feeAtomic: '1000', changeAtomic: '0', totalAtomic: '5000', signature: 'ECDSA' }),
  confirm: async () => ({ txid: 'ab'.repeat(32) }),
  cancel: () => {},
}

const NODE: NodeOps = {
  get: () => ({ selected: 'public', publicUrl: 'https://api.example.org', network: 'mainnet', tor: false, hasAuth: false }),
  select: async (kind) => ({ selected: kind, publicUrl: 'https://api.example.org', network: 'mainnet', tor: false, hasAuth: false }),
  setOwn: async (url, user) => ({ selected: 'own', publicUrl: 'https://api.example.org', network: 'mainnet', ownUrl: url, tor: false, hasAuth: user !== undefined }),
  clearOwn: async () => ({ selected: 'public', publicUrl: 'https://api.example.org', network: 'mainnet', tor: false, hasAuth: false }),
  setTor: (enabled) => ({ selected: 'public', publicUrl: 'https://api.example.org', network: 'mainnet', tor: enabled, hasAuth: false }),
  status: async () => ({ url: 'https://api.example.org', reachable: true, chain: 'main', blockHeight: 1, syncing: false, latencyMs: 5 }),
}

const UPGRADE_OPS: UpgradeOps = {
  info: async () => ({ enabled: false }),
  status: async () => {
    throw new Error('BTC upgrade is not available for this wallet.')
  },
  plan: async () => {
    throw new Error('BTC upgrade is not available for this wallet.')
  },
  convert: async () => {
    throw new Error('BTC upgrade is not available for this wallet.')
  },
  returnBtc: async () => {
    throw new Error('BTC upgrade is not available for this wallet.')
  },
}

function make() {
  const vault = new FakeVault()
  return {
    vault,
    orch: new VaultOrchestrator({ vault, mnemonic: TOOLS, addresses: ADDRESSES, chain: CHAIN, send: SEND, coins: COINS, contacts: CONTACTS, wallets: WALLETS, sweep: SWEEP, node: NODE, upgrade: UPGRADE_OPS }),
  }
}

describe('VaultOrchestrator', () => {
  it('reports the vault status', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'vault.getStatus' })).toEqual({ ok: true, value: 'empty' })
  })

  it('create unlocks', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'vault.create', mnemonic: MNEMONIC, password: 'pw' })).toEqual({ ok: true, value: 'unlocked' })
  })

  it('lock then unlock round-trips the status', async () => {
    const { orch } = make()
    await orch.handle({ type: 'vault.create', mnemonic: MNEMONIC, password: 'pw' })
    expect(await orch.handle({ type: 'vault.lock' })).toEqual({ ok: true, value: 'locked' })
    expect(await orch.handle({ type: 'vault.unlock', password: 'pw' })).toEqual({ ok: true, value: 'unlocked' })
  })

  it('fails a wrong unlock password with a serialized error, no internals', async () => {
    const { orch } = make()
    const r = await orch.handle({ type: 'vault.unlock', password: 'nope' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toEqual({ name: 'Error', message: 'bad password' })
  })

  it('generates and validates mnemonics via the injected tools', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'vault.generateMnemonic' })).toEqual({ ok: true, value: MNEMONIC })
    expect(await orch.handle({ type: 'vault.validateMnemonic', phrase: MNEMONIC })).toEqual({ ok: true, value: true })
    expect(await orch.handle({ type: 'vault.validateMnemonic', phrase: 'nope' })).toEqual({ ok: true, value: false })
  })

  it('routes receive-address requests to the address service', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'wallet.getReceiveAddress' })).toEqual({ ok: true, value: 'EC_receive' })
    expect(await orch.handle({ type: 'wallet.getNewReceiveAddress' })).toEqual({ ok: true, value: 'EC_new' })
    expect(await orch.handle({ type: 'wallet.listReceiveAddresses' })).toEqual({
      ok: true,
      value: [{ address: 'EC_receive', index: 0, current: true }],
    })
  })

  it('routes chain reads to the chain service', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'chain.getSummary' })).toEqual({ ok: true, value: { balanceAtomic: '0', tipHeight: 0, addressCount: 0 } })
    expect(await orch.handle({ type: 'chain.estimateFee' })).toEqual({ ok: true, value: { fast: 1, medium: 1, slow: 1 } })
  })

  it('routes a transaction-label write to the chain ops', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'chain.setTxLabel', txid: 'tx1', label: 'Rent' })).toEqual({ ok: true, value: undefined })
  })

  it('routes send requests to the send service (amount parsed to bigint)', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'wallet.buildSend', recipient: 'ECabc', amountAtomic: '1000' })).toEqual({
      ok: true,
      value: { recipient: 'ECabc', amountAtomic: '1000', feeAtomic: '200', changeAtomic: '0', totalAtomic: '1200', signature: 'ECDSA' },
    })
    expect(await orch.handle({ type: 'wallet.confirmSend' })).toEqual({ ok: true, value: { txid: 'deadbeef' } })
  })

  it('routes coin-control requests to the coin service', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'coins.list' })).toEqual({ ok: true, value: [COIN_ROW] })
    expect(await orch.handle({ type: 'coins.setFrozen', outpoint: 'aa:0', frozen: true })).toEqual({ ok: true, value: undefined })
  })

  it('routes contact requests to the contact service (returns the list)', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'contacts.list' })).toEqual({ ok: true, value: [{ name: 'Amy', address: 'ECamy' }] })
    expect(await orch.handle({ type: 'contacts.add', name: 'Amy', address: 'ECamy' })).toEqual({ ok: true, value: [{ name: 'Amy', address: 'ECamy' }] })
  })

  it('routes wallet-management requests to the wallet ops', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'wallets.list' })).toEqual({ ok: true, value: [] })
    expect(await orch.handle({ type: 'wallets.switch', id: 'default' })).toEqual({ ok: true, value: [] })
  })

  it('changes the password only with the right current password', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'vault.changePassword', oldPassword: 'pw', newPassword: 'newpass12' })).toEqual({ ok: true, value: undefined })
    expect((await orch.handle({ type: 'vault.changePassword', oldPassword: 'x', newPassword: 'newpass12' })).ok).toBe(false)
  })

  it('routes a noteActivity ping to the vault', async () => {
    const { orch, vault } = make()
    expect(await orch.handle({ type: 'vault.noteActivity' })).toEqual({ ok: true, value: undefined })
    expect(vault.activityPings).toBe(1)
  })

  it('routes upgrade requests; the capability probe works while others surface the error', async () => {
    const { orch } = make()
    expect(await orch.handle({ type: 'upgrade.info' })).toEqual({ ok: true, value: { enabled: false } })
    const res = await orch.handle({ type: 'upgrade.status' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.message).toMatch(/not available/)
  })

  it('reveals the mnemonic only with the right password', async () => {
    const { orch } = make()
    await orch.handle({ type: 'vault.create', mnemonic: MNEMONIC, password: 'pw' })
    expect(await orch.handle({ type: 'vault.revealMnemonic', password: 'pw' })).toEqual({ ok: true, value: MNEMONIC })
    expect((await orch.handle({ type: 'vault.revealMnemonic', password: 'x' })).ok).toBe(false)
  })

  it('never returns seed material across the bridge', async () => {
    const { orch, vault } = make()
    const responses = [
      await orch.handle({ type: 'vault.getStatus' }),
      await orch.handle({ type: 'vault.create', mnemonic: MNEMONIC, password: 'pw' }),
      await orch.handle({ type: 'vault.lock' }),
      await orch.handle({ type: 'vault.unlock', password: 'pw' }),
      await orch.handle({ type: 'vault.destroy' }),
    ]
    expect(JSON.stringify(responses)).not.toContain(vault.seed)
  })
})
