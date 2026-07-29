// Typed IPC contract between the renderer (key-free UI) and the main process
// (which owns the Vault). Security boundary: the master seed and BIP-32 key
// NEVER cross it — only requests, public statuses, and the outputs of keys
// (signatures, addresses).
export const WALLET_CHANNEL = 'wallet:request' as const

// main → renderer status broadcasts (e.g. when autolock fires).
export const WALLET_EVENT_CHANNEL = 'wallet:event' as const

// Auto-update: main → renderer lifecycle broadcasts, and renderer → main install
// request. The renderer only reflects status and may ask to restart; it never
// touches the updater directly.
export const UPDATE_EVENT_CHANNEL = 'update:event' as const
export const UPDATE_INSTALL_CHANNEL = 'update:install' as const

export type UpdateEvent =
  | { readonly kind: 'available'; readonly version: string }
  | { readonly kind: 'progress'; readonly percent: number }
  | { readonly kind: 'downloaded'; readonly version: string }
  | { readonly kind: 'error'; readonly message: string }

// Exposed to the renderer as window.updater (see src/preload).
export interface UpdaterApi {
  /** Subscribe to update lifecycle events. Returns an unsubscribe function. */
  onEvent(listener: (event: UpdateEvent) => void): () => void
  /** Apply the downloaded update now: quit and relaunch into the new version. */
  restartToInstall(): void
}

export type WalletRequest = { readonly type: 'ping' }

// --- Vault control ---
// Only the status string crosses the bridge for these. The master seed / BIP-32
// key never cross; the mnemonic crosses solely on an explicit, password-
// re-authenticated reveal (vault.revealMnemonic), and `password` crosses once
// inward on create/unlock/reveal — never retained by the renderer.
export type VaultStatus = 'empty' | 'locked' | 'unlocked'

export type VaultRequest =
  | { readonly type: 'vault.getStatus' }
  | { readonly type: 'vault.create'; readonly mnemonic: string; readonly password: string }
  | { readonly type: 'vault.unlock'; readonly password: string }
  | { readonly type: 'vault.lock' }
  | { readonly type: 'vault.destroy' }
  | { readonly type: 'vault.revealMnemonic'; readonly password: string }
  | { readonly type: 'vault.changePassword'; readonly oldPassword: string; readonly newPassword: string }
  | { readonly type: 'vault.noteActivity' }
  | { readonly type: 'vault.generateMnemonic' }
  | { readonly type: 'vault.validateMnemonic'; readonly phrase: string }
  | { readonly type: 'wallet.getReceiveAddress'; readonly algo?: AddressAlgo }
  | { readonly type: 'wallet.getNewReceiveAddress'; readonly algo?: AddressAlgo }
  | { readonly type: 'wallet.listReceiveAddresses'; readonly algo?: AddressAlgo }
  | { readonly type: 'chain.getSummary' }
  | { readonly type: 'chain.getHistory'; readonly pages?: number }
  | { readonly type: 'chain.listTokens' }
  | { readonly type: 'chain.estimateFee' }
  | { readonly type: 'chain.setTxLabel'; readonly txid: string; readonly label: string }
  | { readonly type: 'chain.getTxDetail'; readonly txid: string }
  | { readonly type: 'chain.getTxRaw'; readonly txid: string }
  | { readonly type: 'chain.getSnapshot' }
  | { readonly type: 'wallet.buildSend'; readonly recipient: string; readonly amountAtomic: string; readonly outpoints?: readonly string[]; readonly sendMax?: boolean }
  | { readonly type: 'wallet.maxSendable'; readonly outpoints?: readonly string[] }
  | { readonly type: 'wallet.buildTokenSend'; readonly tokenId: string; readonly recipient: string; readonly tokenAmountAtomic: string }
  | { readonly type: 'wallet.confirmSend' }
  | { readonly type: 'coins.list' }
  | { readonly type: 'coins.setLabel'; readonly outpoint: string; readonly label: string }
  | { readonly type: 'coins.setFrozen'; readonly outpoint: string; readonly frozen: boolean }
  | { readonly type: 'contacts.list' }
  | { readonly type: 'contacts.add'; readonly name: string; readonly address: string }
  | { readonly type: 'contacts.remove'; readonly address: string }
  | { readonly type: 'wallets.list' }
  | { readonly type: 'wallets.add'; readonly label: string; readonly input: WatchInput }
  | { readonly type: 'wallets.addSeed'; readonly label: string; readonly mnemonic: string; readonly passphrase?: string }
  | { readonly type: 'wallets.addKey'; readonly label: string; readonly wif: string; readonly algo?: AddressAlgo }
  | { readonly type: 'wallets.inspectKey'; readonly wif: string }
  | { readonly type: 'sweep.scan'; readonly wif: string; readonly algo?: AddressAlgo }
  | { readonly type: 'sweep.build'; readonly recipient: string; readonly amountAtomic?: string; readonly sendMax: boolean }
  | { readonly type: 'sweep.confirm' }
  | { readonly type: 'sweep.cancel' }
  | { readonly type: 'wallets.restore'; readonly mnemonic: string; readonly password: string }
  | { readonly type: 'wallets.switch'; readonly id: string }
  | { readonly type: 'wallets.rename'; readonly id: string; readonly label: string }
  | { readonly type: 'wallets.remove'; readonly id: string }
  | { readonly type: 'wallets.exportDescriptor' }
  | { readonly type: 'node.get' }
  | { readonly type: 'node.select'; readonly kind: NodeKind; readonly url?: string }
  | { readonly type: 'node.setOwn'; readonly url: string; readonly user?: string; readonly password?: string }
  | { readonly type: 'node.clearOwn' }
  | { readonly type: 'node.addCustom'; readonly url: string; readonly name?: string }
  | { readonly type: 'node.removeCustom'; readonly url: string }
  | { readonly type: 'node.setTor'; readonly enabled: boolean }
  | { readonly type: 'node.status' }
  | { readonly type: 'network.set'; readonly network: 'mainnet' | 'testnet' }
  | { readonly type: 'upgrade.info' }
  | { readonly type: 'upgrade.status' }
  | { readonly type: 'upgrade.plan'; readonly req: UpgradeConvertRequest }
  | { readonly type: 'upgrade.convert'; readonly req: UpgradeConvertRequest; readonly destAddress: string }
  | { readonly type: 'upgrade.return'; readonly destBtcAddress: string }

// --- BTC→native upgrade (dormant unless the brand configures it) ---
// Satoshi amounts are strings across the bridge, like atomic amounts.

/** Capability probe: whether this build/wallet offers the upgrade flow. */
export interface UpgradeInfo {
  readonly enabled: boolean
  /** Smallest convertible amount in satoshi (consensus parameter), when enabled. */
  readonly minConvertValueSat?: string
}

export type UpgradeConvertRequest =
  | { readonly mode: 'all' }
  | { readonly mode: 'amount'; readonly amountSat: string }

export interface UpgradeEpisodeView {
  readonly txid: string
  readonly lockValueSat: string
  /** Destination scripthash committed via OP_RETURN (hex); null = fallback credit. */
  readonly destScripthashHex: string | null
  readonly confirmed: boolean
  readonly blockHeight?: number
  /** BTC confirmations at status time (credits need 6 + a 2h timer). */
  readonly confirmations?: number
}

export interface UpgradeStatusView {
  readonly stagingAddress: string
  readonly stagingIndex: number
  readonly confirmedBalanceSat: string
  readonly pendingBalanceSat: string
  readonly episodes: readonly UpgradeEpisodeView[]
}

export interface UpgradePlanView {
  readonly sendValueSat: string
  readonly feeSat: string
  readonly changeValueSat: string
  readonly feeRate: number
  readonly foldedChange: boolean
}

export interface UpgradeConvertResult {
  readonly txid: string
}

export interface UpgradeReturnResult {
  readonly txid: string
  readonly valueSat: string
  readonly feeSat: string
}

// --- Chain views (the read models the renderer renders) ---
// Atomic amounts are strings here: bigint is correct inside main but doesn't
// belong in display state or structured-clone payloads.
export interface WalletSummary {
  readonly balanceAtomic: string
  readonly tipHeight: number
  readonly addressCount: number
}

export interface HistoryItem {
  readonly txid: string
  readonly direction: 'in' | 'out'
  readonly amountAtomic: string
  readonly feeAtomic: string
  readonly confirmed: boolean
  readonly blockHeight?: number
  readonly blockTime?: number
  /** Local, user-set label for this transaction (sealed at rest, never on-chain). */
  readonly label?: string
  // When this transaction moved a token, its movement (the headline the UI shows).
  // `amountAtomic` above is then the native coin side — typically 0 on a receive,
  // the fee on a send. `tokenTicker` is the compact label (e.g. "USDT").
  readonly tokenId?: string
  readonly tokenAmountAtomic?: string
  readonly tokenDecimals?: number
  readonly tokenTicker?: string
}

// A slice of history plus whether older transactions remain to be loaded.
export interface HistoryPage {
  readonly items: readonly HistoryItem[]
  readonly hasMore: boolean
}

// One input or output of a transaction, for the detail view. `amountAtomic` is the
// native coin value; a token entry also carries its token id/amount (the renderer
// resolves the ticker). `own` marks our addresses, `pq` our post-quantum ones.
export interface TxIoEntry {
  readonly amountAtomic: string
  readonly address?: string
  readonly own: boolean
  readonly pq: boolean
  readonly tokenId?: string
  readonly tokenAmountAtomic?: string
  // ── Advanced detail (always populated; shown only in advanced mode) ──
  /** scripthash hex — of this output, or of the spent prevout for an input. */
  readonly scripthash?: string
  /** Input only: the outpoint this input spends (source txid + output index). */
  readonly prevoutTxid?: string
  readonly prevoutVout?: number
  /** Input only: the unlocking/redeem script, hex. */
  readonly redeemScript?: string
  /** Input only: signature scheme inferred from the siglist algo byte. */
  readonly sigScheme?: AddressAlgo | 'unknown'
  /** Input only: raw signature-list entries (hex). */
  readonly siglist?: readonly string[]
}

// Full per-transaction detail for the drawer: confirmations, size, totals, and the
// resolved input/output lists. The headline (amount, direction, label, time) comes
// from the HistoryItem the drawer was opened with; this adds the on-chain detail.
export interface TxDetail {
  readonly txid: string
  readonly confirmations: number
  readonly sizeBytes: number
  readonly totalInAtomic: string
  readonly totalOutAtomic: string
  readonly feeAtomic: string
  readonly inputs: readonly TxIoEntry[]
  readonly outputs: readonly TxIoEntry[]
  // ── Advanced detail (always populated; shown only in advanced mode) ──
  /** tx_type id: 1 = standard, 2 = stake, 3 = coinbase, 4 = tokens. */
  readonly txType?: number
  readonly blockHash?: string
  readonly blockHeight?: number
  /** Position of the tx within its block (0 = first). */
  readonly blockPos?: number
  readonly isCoinbase?: boolean
  /**
   * Upgrade-coinbase provenance: the source-chain (BTC) payment this credit
   * stems from. txid is in display byte order; valueSat is what was locked
   * BEFORE the protocol fee (the credit's fee field is that protocol fee).
   */
  readonly coinbaseInfo?: {
    readonly btcTxid: string
    readonly btcBlockHeight: number
    readonly btcOutNum: number
    readonly valueSat: string
  }
}

// Last-known read-model, persisted (sealed with the seed key) so unlock/restart can
// render instantly while fresh data is fetched in the background. Holds only the
// public display models — never keys or seed material.
export interface WalletSnapshot {
  readonly summary?: WalletSummary
  readonly history?: HistoryPage
  readonly tokens?: readonly TokenBalance[]
}

// A token the wallet holds: aggregated atomic balance plus resolved metadata
// (decimals default to 6 when the token's info can't be fetched).
export interface TokenBalance {
  readonly id: string
  readonly amountAtomic: string
  readonly decimals: number
  readonly symbol?: string
  readonly name?: string
}

export interface FeeBands {
  readonly fast: number
  readonly medium: number
  readonly slow: number
}

export interface SendPreview {
  readonly recipient: string
  readonly amountAtomic: string
  readonly feeAtomic: string
  readonly changeAtomic: string
  readonly totalAtomic: string
  /** Human label of the signature scheme(s) the inputs will be signed with. */
  readonly signature: string
}

export interface SendResult {
  readonly txid: string
}

// Preview of a token transfer to confirm. The token amount is in the token's atomic
// units; the fee is native coin (token UTXOs can't pay it).
export interface TokenSendPreview {
  readonly recipient: string
  readonly tokenId: string
  readonly tokenAmountAtomic: string
  readonly feeAtomic: string
  /** Signature scheme(s) the inputs will be signed with (e.g. "ECDSA", "Falcon-512"). */
  readonly signature: string
}

// The most a single transaction can send (whole spendable pool minus the fee, no
// change) plus that fee — used to fill the "Max" control on the Send form.
export interface MaxSendable {
  readonly amountAtomic: string
  readonly feeAtomic: string
}

// A coin-control row: one UTXO with display fields and local metadata.
export interface UtxoView {
  readonly outpoint: string
  readonly address: string
  readonly valueAtomic: string
  readonly confirmations: number
  readonly algo: AddressAlgo
  readonly label?: string
  readonly frozen: boolean
  // Set when this UTXO carries a token (its native `valueAtomic` is then 0). The
  // renderer resolves the ticker/decimals from the token list for display.
  readonly tokenId?: string
  readonly tokenAmountAtomic?: string
}

// An address-book entry.
export interface Contact {
  readonly name: string
  readonly address: string
}

// A derived receive address (for the "all addresses" list).
export interface ReceiveAddressEntry {
  readonly address: string
  readonly index: number
  readonly current: boolean
}

// Which key algorithm an address uses: classical (secp256k1 ECDSA or Schnorr)
// or post-quantum (Falcon-512). Schnorr appears only via imported keys and is
// feature-gated in main; HD wallets derive ECDSA + Falcon branches.
// Mirrors @qbitcoin/crypto's Algorithm — deliberately re-declared here so the
// IPC contract stays dependency-free for the renderer.
export type AddressAlgo = 'ecdsa' | 'schnorr' | 'falcon512'

// A wallet in the multi-wallet registry, for the switcher. `kind` is 'seed' (owns an
// encrypted seed), 'key' (a single imported private key — one fixed address), or
// 'watch' (key-free, read-only). `canSign` is false for watch wallets, so the UI
// can disable Send.
export type WalletKind = 'seed' | 'watch' | 'key'

// Preview of a pasted private key BEFORE importing: which algorithms the payload
// admits (WIF doesn't encode one) and the address each candidate would watch —
// so the user confirms against the expected address, Sparrow-style. Nothing is
// persisted by the inspection.
export interface KeyInspection {
  readonly candidates: readonly AddressAlgo[]
  /** Candidate algorithm → the single address the key would have. */
  readonly addresses: Partial<Record<AddressAlgo, string>>
}

// Result of starting an ephemeral sweep: the address being swept and its current
// balance. The key is held in main only for the sweep's duration (never stored).
export interface SweepScan {
  readonly address: string
  readonly balanceAtomic: string
}

export interface WalletInfo {
  readonly id: string
  readonly kind: WalletKind
  readonly label: string
  readonly active: boolean
  readonly canSign: boolean
  /** False only for the primary wallet (which roots the app-data key); others can be removed. */
  readonly removable: boolean
  /** A representative address (first classical receive) for display; absent if locked. */
  readonly address?: string
}

// The chain backends the wallet can point at. 'public' is the bundled node, 'own' a
// user-run Esplora REST node, 'electrum' the Electrum bridge (not yet wired).
export type NodeKind = 'public' | 'own' | 'electrum' | 'custom'

/** A user-added PUBLIC esplora instance (community-hosted). No credentials —
 *  those belong to the own-node slot; these join the failover pool. */
export interface CustomNodeView {
  readonly url: string
  readonly name?: string
}

// The node-selection settings the Network card renders: which slot is active, the
// public node's URL (for display), the user's own-node URL if set, and the Tor flag.
export interface NodeSettings {
  readonly selected: NodeKind
  readonly publicUrl: string
  readonly ownUrl?: string
  /** User-added public nodes (see CustomNodeView). */
  readonly customNodes: readonly CustomNodeView[]
  /** Which custom node is active when `selected === 'custom'`. */
  readonly selectedCustomUrl?: string
  readonly tor: boolean
  /** Which chain this BUILD runs on (compile-time constant, not a user setting). */
  readonly network: 'mainnet' | 'testnet'
  /** Whether the own node has Basic-auth credentials stored (the password is never returned). */
  readonly hasAuth: boolean
  /** The own-node Basic-auth username, if set (not a secret); for prefilling the form. */
  readonly authUser?: string
}

// Live status of the active endpoint, for the connection indicator. `latencyMs` is
// the measured round-trip of the status call; `reachable` is false when it failed.
export interface NodeStatus {
  readonly url: string
  readonly reachable: boolean
  readonly chain?: string
  readonly blockHeight?: number
  readonly syncing?: boolean
  readonly latencyMs?: number
  /** Upgrade-capable nodes only: whether the node's BTC chain is synced. */
  readonly btcSynced?: boolean
  /** Last known BTC header height (upgrade-capable nodes only). */
  readonly btcHeaders?: number
  /** Last fully scanned BTC block — credits require the scan, not just headers. */
  readonly btcScanned?: number
}

// How the user supplies a watch wallet to add: a descriptor token, a bare account
// xpub (classical only), or an explicit list of addresses to follow.
export type WatchInput =
  | { readonly kind: 'descriptor'; readonly text: string }
  | { readonly kind: 'xpub'; readonly xpub: string }
  | { readonly kind: 'addresses'; readonly addresses: readonly string[] }

export interface PingResult {
  readonly pong: true
  readonly version: string
}

export interface SerializedError {
  readonly name: string
  readonly message: string
}

export type WalletResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SerializedError }

// The surface exposed to the renderer via contextBridge (see src/preload).
export interface WalletApi {
  ping(): Promise<PingResult>
  getStatus(): Promise<VaultStatus>
  create(mnemonic: string, password: string): Promise<VaultStatus>
  unlock(password: string): Promise<VaultStatus>
  lock(): Promise<VaultStatus>
  destroy(): Promise<VaultStatus>
  revealMnemonic(password: string): Promise<string>
  /** Change the unlock password (re-auth with the current one). */
  changePassword(oldPassword: string, newPassword: string): Promise<void>
  /** Signal real user activity (UI input) so main resets the idle-autolock timer. Fire-and-forget. */
  noteActivity(): Promise<void>
  /** Generate a fresh recovery phrase in main (not sealed) for display. */
  generateMnemonic(): Promise<string>
  /** Validate a recovery phrase (words + checksum) in main. */
  validateMnemonic(phrase: string): Promise<boolean>
  /** Current receive address for the chosen algorithm (default classical). Requires unlocked. */
  getReceiveAddress(algo?: AddressAlgo): Promise<string>
  /** Advance to the next receive address (per algorithm) and return it. Requires unlocked. */
  getNewReceiveAddress(algo?: AddressAlgo): Promise<string>
  /** Receive addresses surfaced so far for the chosen algorithm. Requires unlocked. */
  listReceiveAddresses(algo?: AddressAlgo): Promise<readonly ReceiveAddressEntry[]>
  /** Balance + chain tip over the wallet's discovered addresses. Requires unlocked. */
  getSummary(): Promise<WalletSummary>
  /** Transaction history over the wallet's addresses, newest first. `pages` walks that
   *  many Esplora pages per address (default 1); the result flags whether older
   *  transactions remain. Requires unlocked. */
  getHistory(pages?: number): Promise<HistoryPage>
  /** Set (or clear, when empty) a local label for a transaction. Requires unlocked. */
  setTxLabel(txid: string, label: string): Promise<void>
  /** Full detail for one transaction (confirmations, size, totals, inputs/outputs). Requires unlocked. */
  getTxDetail(txid: string): Promise<TxDetail>
  /** Raw serialized transaction, hex — for the advanced view. Requires unlocked. */
  getTxRaw(txid: string): Promise<string>
  /** The last persisted read-model snapshot (or null), to render instantly on unlock. Requires unlocked. */
  getSnapshot(): Promise<WalletSnapshot | null>
  /** Tokens the wallet holds (aggregated across its addresses), with metadata. Requires unlocked. */
  listTokens(): Promise<TokenBalance[]>
  /** Current fee-rate bands (atomic units per vByte). */
  estimateFee(): Promise<FeeBands>
  /** Build and hold a send draft; returns a preview to confirm. Requires unlocked.
   *  Pass `outpoints` (txid:vout) to spend exactly those coins (manual selection).
   *  With `sendMax`, spends the whole pool into one output with no change. */
  buildSend(recipient: string, amountAtomic: string, outpoints?: readonly string[], sendMax?: boolean): Promise<SendPreview>
  /** Largest amount sendable in one transaction (whole pool minus fee, no change). Recipient-free. */
  maxSendable(outpoints?: readonly string[]): Promise<MaxSendable>
  /** Build and hold a token transfer draft; returns a preview to confirm. Requires unlocked. */
  buildTokenSend(tokenId: string, recipient: string, tokenAmountAtomic: string): Promise<TokenSendPreview>
  /** Sign and broadcast the held send draft; returns the txid. Requires unlocked. */
  confirmSend(): Promise<SendResult>
  /** List the wallet's UTXOs with coin-control metadata. Requires unlocked. */
  listCoins(): Promise<UtxoView[]>
  /** Set (or clear, when empty) a UTXO label. */
  setUtxoLabel(outpoint: string, label: string): Promise<void>
  /** Freeze/unfreeze a UTXO (excluded from automatic coin selection). */
  setUtxoFrozen(outpoint: string, frozen: boolean): Promise<void>
  /** The address book, sorted by name. */
  listContacts(): Promise<readonly Contact[]>
  /** Add (or rename) a contact; validates the address. Returns the updated list. */
  addContact(name: string, address: string): Promise<readonly Contact[]>
  /** Remove a contact by address. Returns the updated list. */
  removeContact(address: string): Promise<readonly Contact[]>
  /** All wallets in the registry (for the switcher). */
  listWallets(): Promise<readonly WalletInfo[]>
  /** Add a watch-only wallet from user input; returns the updated list. Requires unlocked. */
  addWatchWallet(label: string, input: WatchInput): Promise<readonly WalletInfo[]>
  /** Import a second seed wallet from a recovery phrase (+ optional passphrase). Requires unlocked. */
  addSeedWallet(label: string, mnemonic: string, passphrase?: string): Promise<readonly WalletInfo[]>
  /** Inspect a private key (WIF): candidate algorithms + the address each would watch. Persists nothing. */
  inspectKey(wif: string): Promise<KeyInspection>
  /** Import a single private key (WIF) as a new key wallet. Requires unlocked.
   *  `algo` picks among the WIF's candidates (default: the first, ECDSA for 32-byte keys). */
  addKeyWallet(label: string, wif: string, algo?: AddressAlgo): Promise<readonly WalletInfo[]>
  /** Start an ephemeral sweep from a WIF: materialize the key in main (never stored)
   *  and return its address + balance. Replaces any previous in-flight sweep. */
  sweepScan(wif: string, algo?: AddressAlgo): Promise<SweepScan>
  /** Build and hold the sweep transaction; returns a preview to confirm. `sendMax`
   *  spends the whole balance with no change (the usual sweep); otherwise `amountAtomic`. */
  sweepBuild(recipient: string, amountAtomic: string | undefined, sendMax: boolean): Promise<SendPreview>
  /** Sign + broadcast the held sweep, then wipe the key from memory. */
  sweepConfirm(): Promise<SendResult>
  /** Abandon an in-flight sweep and wipe the key from memory. */
  sweepCancel(): Promise<void>
  /** Forgot-password recovery: re-create the primary wallet from a recovery phrase + new password. */
  restoreWallet(mnemonic: string, password: string): Promise<VaultStatus>
  /** Make a wallet active; returns the updated list. */
  switchWallet(id: string): Promise<readonly WalletInfo[]>
  /** Rename a wallet; returns the updated list. */
  renameWallet(id: string, label: string): Promise<readonly WalletInfo[]>
  /** Remove a watch wallet and its data; returns the updated list. */
  removeWallet(id: string): Promise<readonly WalletInfo[]>
  /** Export the active seed wallet's watch descriptor (xpub + Falcon list). Requires unlocked. */
  exportWatchDescriptor(): Promise<string>
  /** Current node-selection settings (slots + Tor flag). */
  getNode(): Promise<NodeSettings>
  /** Activate a node slot (public/own); rebuilds the session. Returns updated settings. */
  selectNode(kind: NodeKind, url?: string): Promise<NodeSettings>
  /** Set the user's own-node URL with optional Basic-auth (probes it first); activates it. Returns updated settings. */
  setOwnNode(url: string, user?: string, password?: string): Promise<NodeSettings>
  /** Add (or rename) a user-provided PUBLIC esplora node; probes it first. Returns updated settings. */
  addCustomNode(url: string, name?: string): Promise<NodeSettings>
  /** Remove a custom node; falls back to the public slot if it was active. Returns updated settings. */
  removeCustomNode(url: string): Promise<NodeSettings>
  /** Clear the own-node URL and fall back to the public node. Returns updated settings. */
  clearOwnNode(): Promise<NodeSettings>
  /** Persist the Tor flag (routing not yet wired). Returns updated settings. */
  setTor(enabled: boolean): Promise<NodeSettings>
  /** Live status of the active endpoint (height, syncing, latency) for the indicator. */
  nodeStatus(): Promise<NodeStatus>
  /**
   * Switch the network profile. Persists the choice and RELAUNCHES the app —
   * the promise never resolves usefully; treat the call as fire-and-forget.
   * A no-op when `network` is already the active one.
   */
  setNetwork(network: 'mainnet' | 'testnet'): Promise<void>
  /** Whether the BTC→native upgrade flow is available (brand + wallet kind). */
  upgradeInfo(): Promise<UpgradeInfo>
  /** Staging address, balances and episode history of the upgrade flow. Requires unlocked. */
  upgradeStatus(): Promise<UpgradeStatusView>
  /** Price a conversion (full or a fixed satoshi amount) without touching keys. */
  upgradePlan(req: UpgradeConvertRequest): Promise<UpgradePlanView>
  /** Build, sign and broadcast the conversion; credits the given NATIVE address. */
  upgradeConvert(req: UpgradeConvertRequest, destAddress: string): Promise<UpgradeConvertResult>
  /** Send the whole staging balance back to an arbitrary Bitcoin address. */
  upgradeReturn(destBtcAddress: string): Promise<UpgradeReturnResult>
  /** Subscribe to status changes pushed from main; returns an unsubscribe fn. */
  onStatusChanged(listener: (status: VaultStatus) => void): () => void
}

export function ok<T>(value: T): WalletResponse<T> {
  return { ok: true, value }
}

// Serialise any throwable into a plain { name, message } so no stack or internal
// object ever crosses the bridge.
export function fail(err: unknown): WalletResponse<never> {
  const e = err instanceof Error ? err : new Error(String(err))
  return { ok: false, error: { name: e.name, message: e.message } }
}
