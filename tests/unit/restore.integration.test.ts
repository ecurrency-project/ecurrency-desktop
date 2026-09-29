import { beforeAll, describe, expect, it, vi } from 'vitest'
import { InMemoryVaultStorage, Vault } from '@qbtc/vault'
import { RestorableVault, type RestoreStorage } from '../../src/main/vault/RestorableVault'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const config = { appDataInfo: 'test/restore', autoLockMs: 0 }
let original: string
beforeAll(async () => {
  const storage = new InMemoryVaultStorage()
  const vault = new Vault(storage, config)
  await vault.create(PHRASE, 'old-password')
  vault.lock()
  original = (await storage.read())!
})

function setup() {
  let blob = original
  const storage: RestoreStorage = {
    read: async () => blob,
    write: async (value) => { blob = value },
    clear: vi.fn(async () => { throw new Error('Restore must never delete the old vault') }),
    replace: async (value, check) => { check(); blob = value },
  }
  return { storage, vault: new RestorableVault(storage, config) }
}

describe('atomic desktop recovery with published vault', () => {
  it('replaces the password without deleting storage or unlocking, and keeps the same seed', async () => {
    const { storage, vault } = setup()
    await vault.restore(PHRASE, 'new-password')
    expect(storage.clear).not.toHaveBeenCalled()
    expect(await vault.getStatus()).toBe('locked')
    await expect(vault.unlock('old-password')).rejects.toMatchObject({ name: 'InvalidPasswordError' })
    await vault.unlock('new-password')
    expect(await vault.revealMnemonic('new-password')).toBe(PHRASE)
    vault.lock()
  })
  it('invalid input leaves the old vault untouched', async () => {
    const { storage, vault } = setup()
    await expect(vault.restore('invalid phrase', 'new-password')).rejects.toMatchObject({ name: 'InvalidMnemonicError' })
    expect(await storage.read()).toBe(original)
  })
  it('lock before staging cancels recovery and an already queued unlock', async () => {
    const { storage, vault } = setup()
    const restoring = vault.restore(PHRASE, 'new-password')
    const unlocking = vault.unlock('new-password')
    vault.lock()
    await expect(restoring).rejects.toMatchObject({ name: 'WalletLockedError' })
    await expect(unlocking).rejects.toMatchObject({ name: 'WalletLockedError' })
    expect(await storage.read()).toBe(original)
    expect(vault.isUnlocked()).toBe(false)
  })
  it.each(['cancel', 'write-failure', 'lock-after-commit'] as const)('handles %s at the disk boundary', async (scenario) => {
    const { storage, vault } = setup()
    const replace = storage.replace
    storage.replace = async (blob, check) => {
      if (scenario === 'cancel') vault.lock()
      if (scenario === 'write-failure') throw new Error('Disk full')
      await replace(blob, check)
      if (scenario === 'lock-after-commit') vault.lock()
    }
    await expect(vault.restore(PHRASE, 'new-password')).rejects.toThrow()
    expect(await vault.getStatus()).toBe('locked')
    expect(storage.clear).not.toHaveBeenCalled()
    if (scenario !== 'lock-after-commit') expect(await storage.read()).toBe(original)
    await vault.unlock(scenario === 'lock-after-commit' ? 'new-password' : 'old-password')
    vault.lock()
  })
  it('queues password changes behind the atomic replacement', async () => {
    const { storage, vault } = setup()
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const proceed = new Promise<void>((resolve) => { release = resolve })
    const replace = storage.replace
    storage.replace = async (blob, check) => { entered(); await proceed; await replace(blob, check) }
    const restoring = vault.restore(PHRASE, 'new-password')
    await waiting
    const changing = vault.changePassword('new-password', 'changed-password')
    expect(await storage.read()).toBe(original)
    release()
    await Promise.all([restoring, changing])
    expect(await vault.getStatus()).toBe('locked')
    await vault.unlock('changed-password')
    vault.lock()
  })
  it('keeps the password cooldown when recovering', async () => {
    const { vault } = setup()
    for (let i = 0; i < 4; i++) await expect(vault.unlock('wrong')).rejects.toThrow()
    // Staging takes time: freeze only the throttle clock, not actual KDF timers.
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      await vault.restore(PHRASE, 'new-password')
      expect(await vault.getStatus()).toBe('locked')
      await expect(vault.unlock('new-password')).rejects.toMatchObject({ name: 'UnlockThrottledError' })
    } finally { time.mockRestore(); vault.lock() }
  }, 15_000)
})
