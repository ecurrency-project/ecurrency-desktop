// Public API of @qbitcoin/vault.

export {
  Vault,
  type LockReason,
  type VaultConfig,
  type VaultEvent,
  type VaultListener,
  type VaultStatus,
} from './vault';

export {
  BrowserExtensionStorage,
  InMemoryVaultStorage,
  type BrowserStorageArea,
  type VaultStorage,
} from './storage';

export {
  InvalidMnemonicError,
  InvalidPasswordError,
  VaultEmptyError,
  VaultExistsError,
  WalletLockedError,
} from './errors';
