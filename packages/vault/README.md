# @qbitcoin/vault

Stateful seed-storage layer for the wallet. Sits between
`@qbtc/crypto` (stateless primitives, from npm) and the
extension's background service worker (which wants a single object to
ask "give me the signing key" or "lock the wallet now").

## What it does

```
                   ┌─────────────────────────────────────┐
                   │ Vault (this package)                │
   storage I/O ◀── │   ┌────────────┐  ┌──────────────┐  │
   (chrome.        │   │ state      │  │ in-memory    │  │ ── HD master key ──▶ signing
    storage.       │   │ machine    │  │ master seed  │  │
    local)         │   │ empty/     │  │ + autolock   │  │
                   │   │ locked/    │  │   timer      │  │ ── recovery phrase ──▶ Settings UI
                   │   │ unlocked   │  └──────────────┘  │
                   │   └────────────┘                    │
                   └──────────────────────────────────────┘
                            ▲                  │
                            │ create / unlock  │ state events
                            │ lock / destroy   │ (locked, unlocked, …)
                            │                  ▼
                                   popup UI
```

The package is **the only place** in the extension that holds plaintext
seed material in JS memory. Lock semantics:

- **empty**: no encrypted blob in storage.
- **locked**: blob present, no key in memory.
- **unlocked**: blob present, master seed cached in memory; autolock
  timer running.

On any `lock()` (manual, idle timeout, or implicit on SW termination),
the master seed bytes are zero-filled before release.

## Public API

```typescript
import { Vault, InMemoryVaultStorage } from '@qbitcoin/vault';

// appDataInfo: HKDF label of the app-data key — a chain value from the
// host's chain profile, frozen once data has been sealed under it.
const vault = new Vault(new InMemoryVaultStorage(), { appDataInfo: 'mychain/app-data/v1' });

// First-time setup
await vault.create('abandon abandon … about', 'my password');

// Unlock from a fresh page load (e.g. SW just woke up)
await vault.unlock('my password');

// Sign — only works while unlocked
const masterKey = vault.getMasterKey();   // throws WalletLockedError if locked
// ... use masterKey with @qbtc/crypto's derivePath / addressFromPubkey

// Manual lock
vault.lock();

// Auto-lock fires after 5 min of inactivity by default — every
// getMasterKey() call resets the timer. Configurable via:
const customVault = new Vault(storage, { appDataInfo, autoLockMs: 60_000 }); // 1 min
const noAutolock  = new Vault(storage, { appDataInfo, autoLockMs: 0 });       // disabled

// Listen to state changes (for UI updates).
const off = vault.on((event) => console.log(event.type, event));
// later: off();

// "Show recovery phrase" in Settings.
const mnemonic = vault.revealMnemonic();  // throws WalletLockedError if locked

// Change password without re-deriving keys.
await vault.changePassword('my password', 'new password');

// Wipe everything (logout).
await vault.destroy();
```

## Storage backends

Vault doesn't know about Chrome. It accepts a `VaultStorage` —
anything with `read()`, `write()`, `clear()`. Two implementations
included:

- `InMemoryVaultStorage` — tests, demos. Zero deps.
- `BrowserExtensionStorage` — adapter for `chrome.storage.local`.
  Pass the storage object in:
  ```typescript
  new BrowserExtensionStorage(chrome.storage.local, 'qbt.vault');
  ```

You can also write your own — e.g. wrapping IndexedDB if you need to
store bigger blobs in the future.

## Running tests

```bash
pnpm --filter @qbitcoin/vault test
```

100 % of the state-machine paths are covered, plus auto-lock timer
edge cases (using vitest's fake timers).
