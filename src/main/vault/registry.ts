import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Multi-wallet registry and on-disk layout.
//
// The wallet used to keep a single set of files directly under userData. To support
// several wallets (and watch-only views), each wallet's files now live under
// `userData/wallets/<id>/`, and a small index (`wallets.json`) lists the wallets and
// which one is active. The address book (`contacts.json`) stays global — shared
// across wallets, not per-wallet.
//
// This index is intentionally NOT sealed: it holds only structural data (ids, kinds,
// user labels) and must be readable before any wallet is unlocked. Anything sensitive
// — the seed (vault.json) and, later, a watch wallet's public derivation source — is
// sealed in its own per-wallet file, never here.

export type WalletKind = 'seed' | 'watch' | 'key'

export interface WalletEntry {
  /** Stable id; also the per-wallet directory name under `wallets/`. */
  readonly id: string
  /** 'seed' owns an encrypted seed, 'key' a single imported private key (both
   *  can sign); 'watch' is key-free and read-only. */
  readonly kind: WalletKind
  /** User-facing name shown in the wallet switcher. */
  readonly label: string
  /** Creation time (epoch ms). */
  readonly createdAt: number
}

interface RegistryFile {
  readonly version: number
  readonly wallets: readonly WalletEntry[]
  readonly activeWalletId: string
}

/** Id (and directory name) of the primary seed wallet that has always existed. */
export const DEFAULT_WALLET_ID = 'default'

const REGISTRY_VERSION = 1

// Per-wallet files that move under `wallets/<id>/`. The address book is global and
// deliberately absent from this list.
const PER_WALLET_FILES = ['vault.json', 'walletmeta.json', 'coinmeta.json', 'txlabels.json', 'snapshot.json', 'upgrade.json', 'downgrade.json'] as const

/** Absolute path to a wallet's directory under userData. */
export function walletDir(userDataDir: string, walletId: string): string {
  return join(userDataDir, 'wallets', walletId)
}

/**
 * Move a pre-multi-wallet install's flat files into `wallets/default/`.
 *
 * Idempotent and safe to run on every startup: a file is moved only when the legacy
 * copy exists and the new location does not. The files are opaque blobs (sealed or
 * encrypted ones included), so moving them needs no key. `contacts.json` is left in
 * place — the address book is global.
 */
export function migrateLegacyLayout(userDataDir: string): void {
  const dest = walletDir(userDataDir, DEFAULT_WALLET_ID)
  for (const name of PER_WALLET_FILES) {
    const from = join(userDataDir, name)
    const to = join(dest, name)
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
    }
  }
}

// The registry index. Loaded synchronously at startup (before the event loop matters)
// so `createWalletCore` can stay synchronous; the file is tiny and read once.
export class WalletRegistry {
  private data: RegistryFile

  constructor(private readonly file: string) {
    this.data = this.loadOrInit()
  }

  /** The active wallet's id (its directory name under `wallets/`). */
  getActiveId(): string {
    return this.data.activeWalletId
  }

  /** All known wallets, in registry order. */
  list(): readonly WalletEntry[] {
    return this.data.wallets
  }

  /** Look up a wallet by id, or undefined when unknown. */
  get(id: string): WalletEntry | undefined {
    return this.data.wallets.find((w) => w.id === id)
  }

  /** Append a new wallet. Throws if its id is already taken. */
  add(entry: WalletEntry): void {
    if (this.get(entry.id) !== undefined) throw new Error(`Wallet '${entry.id}' already exists`)
    this.persist({ ...this.data, wallets: [...this.data.wallets, entry] })
  }

  /** Change a wallet's label. Throws if the id is unknown. */
  rename(id: string, label: string): void {
    this.require(id)
    this.persist({ ...this.data, wallets: this.data.wallets.map((w) => (w.id === id ? { ...w, label } : w)) })
  }

  /** Make `id` the active wallet. Throws if the id is unknown. */
  setActive(id: string): void {
    this.require(id)
    if (id !== this.data.activeWalletId) this.persist({ ...this.data, activeWalletId: id })
  }

  /** Remove a wallet. Refuses the last one; reassigns the active id if it was removed. */
  remove(id: string): void {
    this.require(id)
    if (this.data.wallets.length <= 1) throw new Error('Cannot remove the only wallet')
    const wallets = this.data.wallets.filter((w) => w.id !== id)
    const activeWalletId = this.data.activeWalletId === id ? (wallets[0]?.id ?? DEFAULT_WALLET_ID) : this.data.activeWalletId
    this.persist({ ...this.data, wallets, activeWalletId })
  }

  private require(id: string): void {
    if (this.get(id) === undefined) throw new Error(`Unknown wallet '${id}'`)
  }

  private persist(next: RegistryFile): void {
    this.data = next
    this.write(next)
  }

  // Read the index, or seed it with the primary wallet. A missing file is the
  // first launch after the multi-wallet upgrade (or a brand-new install). A file
  // that EXISTS but doesn't parse/validate is user data in trouble: it is never
  // overwritten — the corrupt bytes are set aside (wallets.json.corrupt-<ts>)
  // and the index is rebuilt by scanning the wallet directories, so imported
  // wallets (a key wallet's WIF may exist nowhere else!) stay reachable.
  private loadOrInit(): RegistryFile {
    const parsed = this.read()
    if (isValidRegistry(parsed)) return parsed
    if (existsSync(this.file)) {
      this.backupCorruptFile()
      const rebuilt = this.rebuildFromDisk()
      this.write(rebuilt)
      return rebuilt
    }
    const init: RegistryFile = {
      version: REGISTRY_VERSION,
      wallets: [{ id: DEFAULT_WALLET_ID, kind: 'seed', label: 'Main wallet', createdAt: Date.now() }],
      activeWalletId: DEFAULT_WALLET_ID,
    }
    this.write(init)
    return init
  }

  // Preserve the unreadable index for manual recovery instead of destroying the
  // only copy. Best-effort: if even the rename fails, rebuilding still proceeds
  // (write() replaces the file atomically either way).
  private backupCorruptFile(): void {
    try {
      renameSync(this.file, `${this.file}.corrupt-${String(Date.now())}`)
    } catch {
      // Nothing more we can do — prefer a working wallet over a preserved corpse.
    }
  }

  // Rebuild the index from the on-disk layout: every directory under `wallets/`
  // whose files identify a wallet kind becomes an entry. Labels are generic —
  // the user renames them afterwards — but every wallet is reachable again.
  private rebuildFromDisk(): RegistryFile {
    const walletsRoot = join(dirname(this.file), 'wallets')
    const wallets: WalletEntry[] = []
    let dirs: string[] = []
    try {
      dirs = readdirSync(walletsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    } catch {
      // No wallets/ directory at all — fall through to just the default entry.
    }
    for (const id of dirs) {
      const has = (name: string): boolean => existsSync(join(walletsRoot, id, name))
      if (id === DEFAULT_WALLET_ID || has('vault.json') || has('seed.json')) {
        wallets.push({ id, kind: 'seed', label: id === DEFAULT_WALLET_ID ? 'Main wallet' : 'Recovered wallet', createdAt: Date.now() })
      } else if (has('key.json')) {
        wallets.push({ id, kind: 'key', label: 'Recovered key', createdAt: Date.now() })
      } else if (has('watch.json')) {
        wallets.push({ id, kind: 'watch', label: 'Recovered watch wallet', createdAt: Date.now() })
      }
      // Unrecognizable directory: skip — its files stay on disk untouched.
    }
    // The primary wallet always exists conceptually (it roots the app-data key);
    // list it even if its directory hasn't been created yet, and list it first.
    if (!wallets.some((w) => w.id === DEFAULT_WALLET_ID)) {
      wallets.unshift({ id: DEFAULT_WALLET_ID, kind: 'seed', label: 'Main wallet', createdAt: Date.now() })
    } else {
      wallets.sort((a, b) => (a.id === DEFAULT_WALLET_ID ? -1 : b.id === DEFAULT_WALLET_ID ? 1 : a.id.localeCompare(b.id)))
    }
    return { version: REGISTRY_VERSION, wallets, activeWalletId: DEFAULT_WALLET_ID }
  }

  private read(): unknown {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as unknown
    } catch {
      return null
    }
  }

  private write(data: RegistryFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

function isValidRegistry(data: unknown): data is RegistryFile {
  if (typeof data !== 'object' || data === null) return false
  const d = data as { wallets?: unknown; activeWalletId?: unknown }
  if (typeof d.activeWalletId !== 'string') return false
  if (!Array.isArray(d.wallets) || d.wallets.length === 0) return false
  const wallets = d.wallets as unknown[]
  if (!wallets.every(isValidEntry)) return false
  const activeId = d.activeWalletId
  return (wallets as WalletEntry[]).some((w) => w.id === activeId)
}

function isValidEntry(entry: unknown): entry is WalletEntry {
  if (typeof entry !== 'object' || entry === null) return false
  const e = entry as { id?: unknown; kind?: unknown; label?: unknown; createdAt?: unknown }
  return (
    typeof e.id === 'string' &&
    (e.kind === 'seed' || e.kind === 'watch' || e.kind === 'key') &&
    typeof e.label === 'string' &&
    typeof e.createdAt === 'number'
  )
}
