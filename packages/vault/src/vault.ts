// Vault — stateful seed storage with autolock.
//
// Single source of truth for the wallet's signing key. The vault holds
// the user's mnemonic (encrypted on disk, plaintext in memory while
// unlocked), the BIP-32 master key derived from it, and the lifecycle
// state — empty / locked / unlocked.
//
// This is THE place in the extension that touches plaintext seed bytes.
// Everything else (UI, chain client, dApp provider) asks the vault for
// what it needs; the vault refuses unless unlocked.

import {
  CURRENT_KDF,
  deriveAppDataKey,
  HDKey,
  masterKeyFromSeed,
  mnemonicToSeed,
  openAppData,
  sealAppData,
  sealVault,
  unsealVault,
  validateMnemonic,
  VaultAuthError,
  type VaultBlob,
} from '@qbitcoin/crypto';
import {
  InvalidMnemonicError,
  InvalidPasswordError,
  UnlockThrottledError,
  VaultEmptyError,
  VaultExistsError,
  WalletLockedError,
} from './errors';
import type { VaultStorage } from './storage';

// ─── Configuration ───────────────────────────────────────────────────

/** Default autolock — 5 minutes of inactivity. */
const DEFAULT_AUTO_LOCK_MS = 5 * 60 * 1000;

// Unlock throttle (defence-in-depth on top of the Argon2id KDF). The first few
// wrong passwords are free — fat-fingering a strong password is normal — after
// which a mandatory cooldown grows per failure, capped. In-memory only: it resets
// on app restart, so the KDF cost stays the real brute-force barrier; this just
// blunts rapid repeated guessing within a running session.
const UNLOCK_FREE_ATTEMPTS = 3;
const UNLOCK_BACKOFF_BASE_MS = 1000;
const UNLOCK_BACKOFF_MAX_MS = 30_000;

export interface VaultConfig {
  /**
   * Autolock the vault after this many milliseconds of inactivity.
   * "Activity" is an explicit {@link Vault.noteActivity} call, driven by real
   * user interaction in the UI — NOT internal key access or background reads, so
   * a polling renderer can't hold the wallet open while the user is away. Pass
   * `0` to disable autolock entirely (only do this in trusted dev contexts).
   *
   * Default: 5 minutes.
   */
  readonly autoLockMs?: number;
}

// ─── State + events ──────────────────────────────────────────────────

/** Vault state — derived from storage contents + in-memory key. */
export type VaultStatus = 'empty' | 'locked' | 'unlocked';

/** Reason for a lock event. */
export type LockReason = 'manual' | 'timeout';

/** Events emitted as the vault transitions between states. */
export type VaultEvent =
  | { readonly type: 'created' }
  | { readonly type: 'unlocked' }
  | { readonly type: 'locked'; readonly reason: LockReason }
  | { readonly type: 'destroyed' };

/** Callback signature for `vault.on(...)`. */
export type VaultListener = (event: VaultEvent) => void;

// ─── The class ───────────────────────────────────────────────────────

export class Vault {
  private masterSeed: Uint8Array | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners: Set<VaultListener> = new Set();
  private readonly autoLockMs: number;
  // Unlock-throttle state (in-memory): consecutive wrong-password count and the
  // timestamp until which further unlock attempts are refused.
  private failedUnlocks = 0;
  private unlockBlockedUntil = 0;

  constructor(
    // Named `store` (not `storage`) to dodge WXT's auto-import system,
    // which sees `storage` and tries to inject `import { storage } from
    // 'wxt/utils/storage'` — even in workspace packages outside the
    // extension itself.
    private readonly store: VaultStorage,
    config: VaultConfig = {},
  ) {
    this.autoLockMs = config.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;
    if (this.autoLockMs < 0) {
      throw new RangeError(`autoLockMs must be >= 0, got ${this.autoLockMs}`);
    }
  }

  // ─── State inspection ──────────────────────────────────────────────

  /** Current status. Reads storage to distinguish empty from locked. */
  async getStatus(): Promise<VaultStatus> {
    if (this.masterSeed !== null) return 'unlocked';
    const blob = await this.store.read();
    return blob !== null ? 'locked' : 'empty';
  }

  /** True if the vault is unlocked (master key available). */
  isUnlocked(): boolean {
    return this.masterSeed !== null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new vault from a BIP-39 mnemonic and a password. Leaves
   * the vault in the `unlocked` state — UX-wise, the user typically
   * just finished writing down their seed phrase and would expect to
   * land in the wallet immediately.
   *
   * Throws `VaultExistsError` if a vault is already in storage. The UI
   * should make destroying an existing vault an explicit step.
   */
  async create(mnemonic: string, password: string): Promise<void> {
    const existing = await this.store.read();
    if (existing !== null) throw new VaultExistsError();

    const normalized = mnemonic.trim();
    if (!validateMnemonic(normalized)) throw new InvalidMnemonicError();

    const mnemonicBytes = new TextEncoder().encode(normalized);
    const blob = await sealVault(mnemonicBytes, password);
    await this.store.write(serializeBlob(blob));

    // Wipe the temporary bytes — `sealVault` returns a copy anyway, but
    // hygiene is cheap.
    mnemonicBytes.fill(0);

    // Keep only the seed resident (a zeroable Uint8Array). The mnemonic string
    // is NOT cached — JS strings can't be wiped; revealing it later re-decrypts
    // the blob with a fresh password instead.
    this.masterSeed = mnemonicToSeed(normalized);
    this.startAutoLockTimer();

    this.emit({ type: 'created' });
    this.emit({ type: 'unlocked' });
  }

  /**
   * Unlock an existing vault with `password`. Idempotent: calling
   * `unlock` while already unlocked just refreshes the autolock timer
   * (handy for "user is active" pings).
   *
   * Throws `VaultEmptyError` if there's no vault, `InvalidPasswordError`
   * on wrong password or tampered ciphertext.
   */
  async unlock(password: string): Promise<void> {
    if (this.isUnlocked()) {
      this.refreshTimer();
      return;
    }
    const stored = await this.store.read();
    if (stored === null) throw new VaultEmptyError();

    // Refuse fast (without paying the KDF) while a backoff window is open.
    const wait = this.unlockBlockedUntil - Date.now();
    if (wait > 0) throw new UnlockThrottledError(wait);

    const blob = parseBlob(stored);
    let decrypted: Uint8Array;
    try {
      decrypted = await unsealVault(blob, password);
    } catch (e) {
      if (e instanceof VaultAuthError) {
        this.registerFailedUnlock();
        throw new InvalidPasswordError();
      }
      throw e;
    }
    // Correct password — clear any accumulated unlock-throttle state.
    this.resetUnlockThrottle();
    // KDF migration: upgrade a legacy scrypt vault to Argon2id on a
    // successful unlock. Best-effort — a failed rewrite must not block unlock.
    if (blob.kdf !== CURRENT_KDF) {
      try {
        await this.store.write(serializeBlob(await sealVault(decrypted, password)));
      } catch {
        // Keep the existing (working) blob; retry on a later unlock.
      }
    }

    const mnemonic = new TextDecoder().decode(decrypted);
    decrypted.fill(0);

    // Only the seed is kept resident (see create()); the mnemonic string is
    // transient and goes out of scope here.
    this.masterSeed = mnemonicToSeed(mnemonic);
    this.startAutoLockTimer();

    this.emit({ type: 'unlocked' });
  }

  /**
   * Lock the vault immediately. Wipes the master seed from memory and
   * stops the autolock timer. Idempotent.
   */
  lock(reason: LockReason = 'manual'): void {
    const wasUnlocked = this.isUnlocked();
    this.stopTimer();
    this.wipeSecrets();
    if (wasUnlocked) this.emit({ type: 'locked', reason });
  }

  /**
   * Permanently delete the vault — clears storage AND in-memory secrets.
   * After this returns the vault is back in `empty` state.
   *
   * UI should require explicit confirmation: this is unrecoverable
   * unless the user backed up their seed phrase.
   */
  async destroy(): Promise<void> {
    this.stopTimer();
    this.wipeSecrets();
    this.resetUnlockThrottle();
    await this.store.clear();
    this.emit({ type: 'destroyed' });
  }

  // ─── Authorized operations (require unlocked) ──────────────────────

  /**
   * Signal genuine user activity (pointer/keyboard in the UI), resetting the
   * idle-autolock countdown. This is the ONLY thing that extends the unlock
   * window: internal key access and background reads deliberately do not, so a
   * polling UI can't keep the wallet unlocked while the user is away. No-op when
   * locked/empty or when autolock is disabled.
   */
  noteActivity(): void {
    if (this.masterSeed === null) return;
    this.refreshTimer();
  }

  /**
   * Return the BIP-32 master HD key. Does NOT touch the autolock timer:
   * derivation/signing is routinely driven by background work (discovery,
   * balance polling), so treating it as activity would defeat idle-autolock.
   * Real activity is signalled via {@link noteActivity}. Throws
   * `WalletLockedError` if locked.
   */
  getMasterKey(): HDKey {
    if (this.masterSeed === null) throw new WalletLockedError();
    return masterKeyFromSeed(this.masterSeed);
  }

  /**
   * Reveal the recovery mnemonic for display in Settings. Requires a FRESH
   * password — the wallet never keeps the mnemonic resident (an immutable JS
   * string can't be zeroed), so we re-decrypt the stored blob on demand. Only
   * the seed is held in memory, and it's wiped on lock.
   *
   * Must be unlocked AND given the correct password — defence-in-depth against
   * shoulder-surfing a momentarily unattended unlocked wallet. Does NOT touch
   * the autolock timer (the UI signals activity via {@link noteActivity}). The
   * returned string is transient: the UI shows it and drops it; it is never
   * stored here.
   *
   * Throws `WalletLockedError` if locked, `VaultEmptyError` if there's no
   * vault, `InvalidPasswordError` on a wrong password.
   */
  async revealMnemonic(password: string): Promise<string> {
    if (this.masterSeed === null) throw new WalletLockedError();
    const stored = await this.store.read();
    if (stored === null) throw new VaultEmptyError();

    const blob = parseBlob(stored);
    let decrypted: Uint8Array;
    try {
      decrypted = await unsealVault(blob, password);
    } catch (e) {
      if (e instanceof VaultAuthError) throw new InvalidPasswordError();
      throw e;
    }
    const mnemonic = new TextDecoder().decode(decrypted);
    decrypted.fill(0);
    return mnemonic;
  }

  /**
   * Encrypt non-key local data (e.g. the address book) at rest with a key
   * derived from the seed (HKDF; see @qbitcoin/crypto appData). Available only
   * when unlocked; the derived key never leaves the background and is wiped
   * after use. Does NOT reset the autolock timer — reading the address book
   * shouldn't extend the unlock window the way a signing operation does.
   */
  async sealData(plaintext: string): Promise<string> {
    if (this.masterSeed === null) throw new WalletLockedError();
    const key = deriveAppDataKey(this.masterSeed);
    try {
      return await sealAppData(key, new TextEncoder().encode(plaintext));
    } finally {
      key.fill(0);
    }
  }

  /**
   * Decrypt data sealed by {@link sealData}. Throws `WalletLockedError` if
   * locked; the crypto layer throws `AppDataError` on a malformed or foreign
   * blob (wrong key / tampered).
   */
  async openData(blob: string): Promise<string> {
    if (this.masterSeed === null) throw new WalletLockedError();
    const key = deriveAppDataKey(this.masterSeed);
    try {
      return new TextDecoder().decode(await openAppData(key, blob));
    } finally {
      key.fill(0);
    }
  }

  /**
   * Change the password without re-deriving keys. Vault must be locked
   * or unlocked (not empty). Works whether or not the vault is
   * currently unlocked — the unlocked state is preserved.
   *
   * Throws `InvalidPasswordError` on wrong old password.
   */
  async changePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const stored = await this.store.read();
    if (stored === null) throw new VaultEmptyError();

    const blob = parseBlob(stored);
    let decrypted: Uint8Array;
    try {
      decrypted = await unsealVault(blob, oldPassword);
    } catch (e) {
      if (e instanceof VaultAuthError) throw new InvalidPasswordError();
      throw e;
    }
    const newBlob = await sealVault(decrypted, newPassword);
    decrypted.fill(0);
    await this.store.write(serializeBlob(newBlob));
    // In-memory state stays as-is.
  }

  // ─── Events ────────────────────────────────────────────────────────

  /**
   * Register a listener for state events. Returns an unsubscribe
   * function. Listeners are called synchronously in registration order.
   */
  on(listener: VaultListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: VaultEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────

  // Count a wrong-password attempt and, past the free allowance, open a cooldown
  // window that grows per failure (capped). See the UNLOCK_* constants.
  private registerFailedUnlock(): void {
    this.failedUnlocks += 1;
    if (this.failedUnlocks > UNLOCK_FREE_ATTEMPTS) {
      const over = this.failedUnlocks - UNLOCK_FREE_ATTEMPTS; // 1, 2, 3, …
      const backoff = Math.min(UNLOCK_BACKOFF_BASE_MS * 2 ** (over - 1), UNLOCK_BACKOFF_MAX_MS);
      this.unlockBlockedUntil = Date.now() + backoff;
    }
  }

  private resetUnlockThrottle(): void {
    this.failedUnlocks = 0;
    this.unlockBlockedUntil = 0;
  }

  private wipeSecrets(): void {
    if (this.masterSeed !== null) {
      this.masterSeed.fill(0);
      this.masterSeed = null;
    }
  }

  private startAutoLockTimer(): void {
    if (this.autoLockMs > 0) this.refreshTimer();
  }

  private refreshTimer(): void {
    if (this.autoLockMs <= 0) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lock('timeout');
    }, this.autoLockMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ─── Blob serialization helpers ──────────────────────────────────────

function serializeBlob(blob: VaultBlob): string {
  return JSON.stringify(blob);
}

function parseBlob(serialized: string): VaultBlob {
  // We trust the storage layer to give us back what we wrote — if it
  // returns garbage, JSON.parse will throw with a meaningful message
  // that bubbles up to the UI.
  return JSON.parse(serialized) as VaultBlob;
}
