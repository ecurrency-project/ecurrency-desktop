// Storage abstraction for the encrypted vault blob.
//
// Vault doesn't know where its bytes live — that's a runtime decision
// (chrome.storage.local in the extension, IndexedDB in some future
// scenario, a plain Map for tests). It calls into this interface and
// gets back a JSON-string blob (or null if no vault is stored).

/**
 * The persistence boundary. Implementations decide where the encrypted
 * blob actually lives.
 */
export interface VaultStorage {
  /** Return the stored blob, or `null` if nothing is stored. */
  read(): Promise<string | null>;

  /** Replace the stored blob. */
  write(blob: string): Promise<void>;

  /** Remove the stored blob if any (idempotent — `clear()` on empty is OK). */
  clear(): Promise<void>;
}

// ─── InMemoryVaultStorage — for tests ────────────────────────────────

/**
 * A storage backend that lives entirely in JS memory. Useful in tests
 * and in unusual environments where no persistent storage is available.
 * Not suitable for production — the data is lost when the JS context
 * is torn down.
 */
export class InMemoryVaultStorage implements VaultStorage {
  private blob: string | null = null;

  async read(): Promise<string | null> {
    return this.blob;
  }

  async write(blob: string): Promise<void> {
    this.blob = blob;
  }

  async clear(): Promise<void> {
    this.blob = null;
  }
}

// ─── BrowserExtensionStorage — for the extension runtime ─────────────

/**
 * Minimal shape of a `chrome.storage.local`-like object that
 * `BrowserExtensionStorage` will use. Promise-based, as in MV3.
 *
 * We accept this as duck-typed so the package doesn't need a hard
 * dependency on `@types/chrome` at runtime — callers just pass in
 * `chrome.storage.local` and it works.
 */
export interface BrowserStorageArea {
  get(keys: string | string[] | null): Promise<{ [key: string]: unknown }>;
  set(items: { [key: string]: unknown }): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/**
 * Adapter for `chrome.storage.local` (and compatible: Firefox
 * `browser.storage.local`, MV3 service workers, etc.). Stores the
 * vault blob under a single key, default `"qbt.vault"` (a brand value: shipped brands keep theirs forever).
 */
export class BrowserExtensionStorage implements VaultStorage {
  constructor(
    private readonly area: BrowserStorageArea,
    private readonly key: string = 'qbt.vault',
  ) {}

  async read(): Promise<string | null> {
    const result = await this.area.get(this.key);
    const value = result[this.key];
    return typeof value === 'string' ? value : null;
  }

  async write(blob: string): Promise<void> {
    await this.area.set({ [this.key]: blob });
  }

  async clear(): Promise<void> {
    await this.area.remove(this.key);
  }
}
