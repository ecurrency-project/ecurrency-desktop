import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InMemoryVaultStorage, Vault } from '@qbtc/vault'
import { falcon512KeygenFromSeed, getPublicKey, masterKeyFromSeed, mnemonicToSeed, schnorrGetPublicKey } from '@qbtc/crypto'
import { addressFromPubkey, encodeWif, exportAccountXpub } from '../../src/main/brand/crypto'
import { RestorableVault, type RestoreStorage } from '../../src/main/vault/RestorableVault'
import type { WalletEntry } from '../../src/main/vault/registry'
import { WalletBackupService } from '../../src/main/wallet/WalletBackupService'
import { importedKeyFromStored } from '../../src/main/wallet/keyWallet'
import { parseWatchInput } from '../../src/main/wallet/watchSource'
import { descriptorSchemes, parseWatchDescriptor } from '../../src/main/wallet/watchDescriptor'
import { SensitiveSessionError } from '../../src/shared/privacy'
import type { WalletBackup } from '../../src/shared/protocol'

const PRIMARY = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const IMPORTED = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const PASSPHRASE = '  Café e\u0301 密碼  '
const PASSWORD = 'test-only-password'
const config = { appDataInfo: 'test/wallet-backup', autoLockMs: 0 }
const scalar = new Uint8Array(32).fill(1)
const wif = encodeWif(scalar, 'mainnet')
const address = addressFromPubkey(getPublicKey(scalar), 'ecdsa', 'mainnet')
const schnorrAddress = addressFromPubkey(schnorrGetPublicKey(scalar), 'schnorr', 'mainnet')
let falconWif: string, falconAddress: string, original: string
const live: RestorableVault[] = []
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
beforeAll(async () => {
  const store = new InMemoryVaultStorage()
  const vault = new Vault(store, config)
  await vault.create(PRIMARY, PASSWORD)
  original = (await store.read())!
  vault.lock()
  const kp = await falcon512KeygenFromSeed(new Uint8Array(48).fill(7))
  const payload = new Uint8Array([...kp.privateKey, ...kp.publicKey])
  falconWif = encodeWif(payload, 'mainnet')
  falconAddress = addressFromPubkey(kp.publicKey, 'falcon512', 'mainnet')
  kp.privateKey.fill(0); payload.fill(0)
})
afterEach(() => { for (const vault of live.splice(0)) vault.lock(); vi.restoreAllMocks() })

async function setup() {
  let blob = original
  const persistence: RestoreStorage = {
    read: async () => blob, write: async (value) => { blob = value },
    clear: async () => { blob = '' }, replace: async (value, check) => { check(); blob = value },
  }
  const vault = new RestorableVault(persistence, config)
  live.push(vault)
  await vault.unlock(PASSWORD)
  const entries = new Map<string, WalletEntry>([
    ['default', { id: 'default', kind: 'seed', label: 'Same name', createdAt: 0 }],
    ['seed', { id: 'seed', kind: 'seed', label: 'Same name', createdAt: 1 }],
    ['key', { id: 'key', kind: 'key', label: 'Key', createdAt: 2 }],
    ['watch', { id: 'watch', kind: 'watch', label: 'Public', createdAt: 3 }],
  ])
  let active = 'seed'
  const registry = { get: (id: string) => entries.get(id), getActiveId: () => active }
  const files = new Map<string, string>()
  files.set('seed/seed.json', await vault.sealData(JSON.stringify({ mnemonic: IMPORTED, passphrase: PASSPHRASE })))
  files.set('key/key.json', await vault.sealData(JSON.stringify({ wif, algo: 'ecdsa', address })))
  files.set('watch/watch.json', await vault.sealData(JSON.stringify({ type: 'addresses', network: 'mainnet', addresses: [address, schnorrAddress] })))
  const read = vi.fn(async (path: string): Promise<string | null> => files.get(path) ?? null)
  const write = vi.fn(async () => { throw new Error('Read-only backup operation') })
  const backup = new WalletBackupService(vault, registry, 'mainnet', (id, file) => ({ read: () => read(`${id}/${file}`), write }))
  const select = (id: string) => { active = id; backup.invalidate() }
  const reveal = () => backup.reveal(active, PASSWORD, () => {})
  return { vault, persistence, files, read, write, backup, entries, select, reveal }
}

describe('wallet-specific backup with the published vault and sealed stores', () => {
  it('returns each wallet’s own seed and exact passphrase even when names match', async () => {
    const { reveal, select, write } = await setup()
    const second = await reveal()
    expect(second).toEqual({ walletId: 'seed', kind: 'seed', mnemonic: IMPORTED, passphrase: PASSPHRASE })
    if (second.kind !== 'seed') throw new Error('Expected a seed backup')
    const restored = masterKeyFromSeed(mnemonicToSeed(second.mnemonic, second.passphrase))
    const expected = masterKeyFromSeed(mnemonicToSeed(IMPORTED, PASSPHRASE))
    const withoutPass = masterKeyFromSeed(mnemonicToSeed(IMPORTED))
    expect(exportAccountXpub(restored, 'mainnet')).toBe(exportAccountXpub(expected, 'mainnet'))
    expect(exportAccountXpub(restored, 'mainnet')).not.toBe(exportAccountXpub(withoutPass, 'mainnet'))
    restored.wipePrivateData(); expected.wipePrivateData(); withoutPass.wipePrivateData()
    select('default')
    expect(await reveal()).toEqual({ walletId: 'default', kind: 'seed', mnemonic: PRIMARY })
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['ecdsa', 'schnorr', 'falcon512'] as const)('backs up and reimports %s with its correct address', async (algo) => {
    const { vault, files, select, reveal } = await setup()
    const stored = { wif: algo === 'falcon512' ? falconWif : wif, algo, address: algo === 'falcon512' ? falconAddress : algo === 'schnorr' ? schnorrAddress : address }
    files.set('key/key.json', await vault.sealData(JSON.stringify(stored)))
    select('key')
    const result = await reveal()
    expect(result).toEqual({ walletId: 'key', kind: 'key', ...stored, network: 'mainnet' })
    if (result.kind !== 'key') throw new Error('Expected a key backup')
    const imported = await importedKeyFromStored(result, 'mainnet')
    expect(imported.address).toBe(stored.address)
    imported.privateKey.fill(0)
  })

  it('requires fresh authentication before reading an imported secret and shares cooldown across wallets', async () => {
    const { backup, vault, read, select } = await setup()
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    for (let i = 0; i < 4; i++) {
      const id = i % 2 === 0 ? 'seed' : 'key'
      select(id)
      await expect(backup.reveal(id, 'wrong', () => {})).rejects.toMatchObject({ name: 'InvalidPasswordError' })
    }
    expect(read).not.toHaveBeenCalled()
    await vault.unlock(PASSWORD) // an unlocked no-op is not reauthentication
    select('default')
    await expect(backup.reveal('default', PASSWORD, () => {})).rejects.toMatchObject({ name: 'UnlockThrottledError' })
    await expect(vault.changePassword(PASSWORD, 'new-password')).rejects.toMatchObject({ name: 'UnlockThrottledError' })
    vault.lock()
    await expect(vault.unlock(PASSWORD)).rejects.toMatchObject({ name: 'UnlockThrottledError' })
  })

  it('refuses watch-only, missing and inactive IDs without running password verification', async () => {
    const { backup, vault, select, entries } = await setup()
    const auth = vi.spyOn(vault, 'revealMnemonic')
    for (const id of ['default', '../seed', '', 'missing']) await expect(backup.reveal(id, PASSWORD, () => {})).rejects.toThrow()
    select('watch')
    await expect(backup.reveal('watch', PASSWORD, () => {})).rejects.toThrow(/no private keys/)
    entries.set('../seed', { id: '../seed', kind: 'seed', label: 'Bad path', createdAt: 0 })
    select('../seed')
    await expect(backup.reveal('../seed', PASSWORD, () => {})).rejects.toThrow(/identifier/)
    expect(auth).not.toHaveBeenCalled()
  })

  it.each(['missing', 'malformed', 'wrong-type', 'damaged'] as const)('never falls back to Main seed on %s data', async (mode) => {
    const { files, vault, reveal } = await setup()
    if (mode === 'missing') files.delete('seed/seed.json')
    else files.set('seed/seed.json', mode === 'damaged' ? 'broken ciphertext' : await vault.sealData(mode === 'malformed' ? `secret-${IMPORTED}` : JSON.stringify({ mnemonic: IMPORTED, passphrase: 42 })))
    const result = await reveal().catch((error: Error) => ({ message: error.message }))
    expect(result).toHaveProperty('message')
    expect(JSON.stringify(result)).not.toContain(PRIMARY)
    expect(JSON.stringify(result)).not.toContain(IMPORTED)
  })

  it('refuses a stored key/address mismatch without exposing plaintext in its error', async () => {
    const { files, vault, select, reveal } = await setup()
    files.set('key/key.json', await vault.sealData(JSON.stringify({ wif, algo: 'ecdsa', address: schnorrAddress })))
    select('key')
    await expect(reveal()).rejects.toThrow('This wallet’s private key data is inconsistent.')
  })

  it.each(['permission', 'switch-back', 'remove', 'lock-unlock', 'password', 'restore'] as const)('cancels before imported reads after %s during authentication', async (reason) => {
    const { vault, backup, read, select, entries } = await setup()
    const entered = deferred(), release = deferred()
    const authenticate = vault.revealMnemonic.bind(vault)
    vi.spyOn(vault, 'revealMnemonic').mockImplementation(async (password) => {
      const phrase = await authenticate(password)
      entered.resolve(); await release.promise
      return phrase
    })
    let allowed = true
    const pending = backup.reveal('seed', PASSWORD, () => { if (!allowed) throw new SensitiveSessionError() }).then(() => 'unexpected success', (e: Error) => e.name)
    await entered.promise
    if (reason === 'permission') allowed = false
    else if (reason === 'switch-back') { select('key'); select('seed') }
    else if (reason === 'remove') entries.delete('seed')
    else if (reason === 'lock-unlock') { vault.lock(); await vault.unlock(PASSWORD) }
    else if (reason === 'password') await vault.changePassword(PASSWORD, 'changed-password')
    else { await vault.restore(PRIMARY, PASSWORD); await vault.unlock(PASSWORD) }
    release.resolve()
    expect(await pending).not.toBe('unexpected success')
    expect(read).not.toHaveBeenCalled()
  })

  it('does not decrypt a blob if the permission ends while reading its file', async () => {
    const { backup, files, read, vault } = await setup()
    const entered = deferred(), release = deferred()
    read.mockImplementation(async (path) => { entered.resolve(); await release.promise; return files.get(path) ?? null })
    const open = vi.spyOn(vault, 'openData')
    let allowed = true
    const pending = backup.reveal('seed', PASSWORD, () => { if (!allowed) throw new SensitiveSessionError() }).catch((e: Error) => e.name)
    await entered.promise; allowed = false; release.resolve()
    expect(await pending).toBe('SensitiveSessionError')
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects plaintext arriving from a decryption after wallet switch', async () => {
    const { backup, vault, select } = await setup()
    const entered = deferred(), release = deferred()
    const open = vault.openData.bind(vault)
    vi.spyOn(vault, 'openData').mockImplementation(async (blob) => { const result = await open(blob); entered.resolve(); await release.promise; return result })
    const pending = backup.reveal('seed', PASSWORD, () => {}).catch((e: Error) => e.name)
    await entered.promise; select('key'); release.resolve()
    expect(await pending).toBe('SensitiveSessionError')
  })

  it('exports watch sources without secret reauthentication and preserves the full public source', async () => {
    const { vault, files, backup, select } = await setup()
    select('watch')
    const auth = vi.spyOn(vault, 'revealMnemonic')
    const addresses = await backup.exportPublic('watch')
    expect(addresses).toEqual({ walletId: 'watch', kind: 'addresses', network: 'mainnet', text: `${address}\n${schnorrAddress}` })
    expect(parseWatchInput({ kind: 'addresses', addresses: addresses.text.split('\n') }, 'mainnet')).toMatchObject({ addresses: [address, schnorrAddress] })
    const master = masterKeyFromSeed(mnemonicToSeed(IMPORTED, PASSPHRASE))
    const source = parseWatchInput({ kind: 'xpub', xpub: exportAccountXpub(master, 'mainnet') }, 'mainnet')
    master.wipePrivateData()
    files.set('watch/watch.json', await vault.sealData(JSON.stringify(source)))
    const exported = await backup.exportPublic('watch')
    expect(parseWatchInput({ kind: 'descriptor', text: exported.text }, 'mainnet')).toEqual(source)
    if (source.type !== 'descriptor') throw new Error('Expected a descriptor')
    files.set('watch/watch.json', await vault.sealData(JSON.stringify({ ...source, descriptor: { ...source.descriptor, mnemonic: PRIMARY, unexpected: { wif } } })))
    expect((await backup.exportPublic('watch')).text).toBe(exported.text)
    expect(auth).not.toHaveBeenCalled()
  })

  it('exports the imported seed’s public descriptor and not Main wallet’s', async () => {
    const { backup, vault } = await setup()
    const auth = vi.spyOn(vault, 'revealMnemonic')
    const data = await backup.exportPublic('seed')
    const master = masterKeyFromSeed(mnemonicToSeed(IMPORTED, PASSPHRASE))
    expect(descriptorSchemes(parseWatchDescriptor(data.text))[0]!.classicalXpub).toBe(exportAccountXpub(master, 'mainnet'))
    master.wipePrivateData()
    expect(data.text).not.toContain(PASSPHRASE)
    expect(auth).not.toHaveBeenCalled()
  }, 20_000)

  it('invalidates public exports and backup grants on credential changes, including pending writes', async () => {
    const { vault, backup, select, read, files } = await setup()
    select('watch')
    const entered = deferred(), release = deferred()
    read.mockImplementation(async (path) => { entered.resolve(); await release.promise; return files.get(path) ?? null })
    const result = backup.exportPublic('watch').catch((error: Error) => error.name)
    await entered.promise
    const changed = vault.changePassword(PASSWORD, 'new-password')
    expect(() => vault.captureBackupContext()).toThrow()
    await changed; release.resolve()
    expect(await result).toBe('WalletLockedError')
  })

  it('keeps imported backups readable after password change and a fresh vault instance', async () => {
    const { vault, persistence, files, select, reveal } = await setup()
    await vault.changePassword(PASSWORD, 'new-password'); vault.lock()
    const restarted = new RestorableVault(persistence, config)
    live.push(restarted)
    await restarted.unlock('new-password')
    const registry = { getActiveId: () => 'seed', get: () => ({ id: 'seed', kind: 'seed' as const, label: 'Imported', createdAt: 1 }) }
    const backup = new WalletBackupService(restarted, registry, 'mainnet', (id, file) => ({ read: async () => files.get(`${id}/${file}`) ?? null, write: async () => { throw new Error('No writes') } }))
    const result: WalletBackup = await backup.reveal('seed', 'new-password', () => {})
    expect(result).toMatchObject({ mnemonic: IMPORTED, passphrase: PASSPHRASE })
    select('key')
    await expect(reveal()).rejects.toMatchObject({ name: 'WalletLockedError' })
  })
})
