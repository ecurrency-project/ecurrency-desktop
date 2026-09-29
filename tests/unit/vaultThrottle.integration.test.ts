import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryVaultStorage, Vault } from '@qbtc/vault'
import { fail } from '../../src/shared/protocol'
import { passwordError } from '../../src/renderer/lib/passwordError'

// Published package, real KDF/storage. Public BIP39 test vector only.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSWORD = 'test-password-only'
afterEach(() => vi.restoreAllMocks())

describe('published vault shared throttle', () => {
  it('preserves the cooldown across reveal, changePassword, lock and IPC serialization', async () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const vault = new Vault(new InMemoryVaultStorage(), { appDataInfo: 'test/throttle', autoLockMs: 0 })
    await vault.create(PHRASE, PASSWORD)
    for (const attempt of [() => vault.revealMnemonic('wrong'), () => vault.changePassword('wrong', PASSWORD), () => vault.revealMnemonic('wrong'), () => vault.changePassword('wrong', PASSWORD)]) {
      await expect(attempt()).rejects.toMatchObject({ name: 'InvalidPasswordError' })
    }
    // An already-unlocked call does not authenticate and cannot reset failures.
    await vault.unlock(PASSWORD)
    await expect(vault.revealMnemonic(PASSWORD)).rejects.toMatchObject({ name: 'UnlockThrottledError', retryAfterMs: 1000 })
    vault.lock()
    const error = await vault.unlock(PASSWORD).catch((error: unknown) => error)
    expect(fail(error)).toEqual({ ok: false, error: { name: 'UnlockThrottledError', message: (error as Error).message, retryAfterMs: 1000 } })
    expect(passwordError(error)).toContain('1 second')
    await expect(vault.changePassword(PASSWORD, 'new-password')).rejects.toMatchObject({ name: 'UnlockThrottledError', retryAfterMs: 1000 })
    now += 1000
    await expect(vault.unlock('wrong')).rejects.toMatchObject({ name: 'InvalidPasswordError' })
    await expect(vault.unlock(PASSWORD)).rejects.toMatchObject({ retryAfterMs: 2000 })
    now += 2000
    await vault.unlock(PASSWORD)
    expect(await vault.revealMnemonic(PASSWORD)).toBe(PHRASE)
    await vault.changePassword(PASSWORD, 'new-password')
    vault.lock()
    await vault.unlock('new-password')
    vault.lock()
  }, 30_000)

  it('serializes concurrent authentication calls against the same counter', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0)
    const vault = new Vault(new InMemoryVaultStorage(), { appDataInfo: 'test/concurrency', autoLockMs: 0 })
    await vault.create(PHRASE, PASSWORD)
    const results = await Promise.allSettled([
      vault.revealMnemonic('wrong'), vault.changePassword('wrong', PASSWORD),
      vault.revealMnemonic('wrong'), vault.changePassword('wrong', PASSWORD), vault.revealMnemonic('wrong'),
    ])
    expect(results.map((result) => result.status === 'rejected' ? (result.reason as Error).name : 'unexpected success')).toEqual([
      'InvalidPasswordError', 'InvalidPasswordError', 'InvalidPasswordError', 'InvalidPasswordError', 'UnlockThrottledError',
    ])
    vault.lock()
  }, 30_000)
})
