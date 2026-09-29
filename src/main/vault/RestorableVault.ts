import { validateMnemonic } from '@qbtc/crypto'
import { InMemoryVaultStorage, InvalidMnemonicError, Vault, WalletLockedError, type LockReason, type VaultConfig, type VaultStorage } from '@qbtc/vault'

export interface RestoreStorage extends VaultStorage {
  /** Check cancellation immediately before committing the replacement. */
  replace(blob: string, check: () => void): Promise<void>
}

// Desktop restore is one operation, including staging and disk replacement.
// A lock cancels that entire operation, even between Vault calls.
// All writes share this queue so a password change/destroy cannot race restore.
export class RestorableVault extends Vault {
  private epoch = 0
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(private readonly persistence: RestoreStorage, private readonly config: VaultConfig) {
    super(persistence, config)
  }

  override lock(reason: LockReason = 'manual'): void {
    this.epoch++
    super.lock(reason)
  }

  private mutate(operation: (check: () => void) => Promise<void>): Promise<void> {
    const epoch = this.epoch
    const check = (): void => { if (epoch !== this.epoch) throw new WalletLockedError() }
    const result = this.mutations.then(async () => {
      check()
      await operation(check)
      check()
    })
    this.mutations = result.catch(() => {})
    return result
  }

  override create(mnemonic: string, password: string): Promise<void> {
    return this.mutate(() => super.create(mnemonic, password))
  }

  override unlock(password: string): Promise<void> {
    return this.mutate(() => super.unlock(password))
  }

  override changePassword(oldPassword: string, newPassword: string): Promise<void> {
    return this.mutate(() => super.changePassword(oldPassword, newPassword))
  }

  override destroy(): Promise<void> {
    this.lock()
    return this.mutate(() => super.destroy())
  }

  async restore(mnemonic: string, password: string): Promise<void> {
    const phrase = mnemonic.trim().replace(/\s+/g, ' ')
    if (!validateMnemonic(phrase)) throw new InvalidMnemonicError()
    this.lock()
    return this.mutate(async (check) => {
      const staging = new InMemoryVaultStorage()
      const candidate = new Vault(staging, { ...this.config, autoLockMs: 0 })
      try {
        await candidate.create(phrase, password)
        candidate.lock()
        check()
        const blob = await staging.read()
        check()
        if (blob === null) throw new Error('Could not prepare the restored wallet.')
        // The old ciphertext remains readable until the atomic rename. If a
        // lock races the rename, the complete replacement stays locked.
        await this.persistence.replace(blob, check)
        check()
        // Recovery never grants an unlock. The user explicitly unlocks with
        // the new password afterwards, through the normal password throttle.
      } finally {
        candidate.lock()
        await staging.clear()
      }
    })
  }
}
