import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { Contact, HistoryItem, HistoryPage, NodeStatus, TokenBalance, TxDetail, UtxoView, WalletInfo, WalletSnapshot, WalletSummary } from '../../shared/protocol'
import { wallet } from './wallet'

// Stale-while-revalidate cache for the wallet's read models. Screens read through
// here instead of fetching on mount, so navigating between panes serves the last
// value instantly (no loader) and the node is only re-hit when the value is stale
// or a mutation invalidated it. A read going stale revalidates in the background
// behind the visible data — never a loader once we have something to show.
//
// Security: this cache holds only public read models (balances, history, coins,
// contacts) — never the seed or any key — and it is wiped on lock.

type Listener = () => void

interface Entry<T> {
  readonly data?: T
  readonly error?: Error
  /** Epoch ms of the last successful fetch; 0 means "never loaded". */
  readonly fetchedAt: number
}

// A cached value is served without refetching while it is younger than this. The
// chain produces a block roughly every 10s, so a slightly larger window avoids
// refetching on every pane switch while keeping balances reasonably fresh; an
// explicit Refresh or a mutation (send, freeze, …) bypasses it.
const FRESH_MS = 15_000

const entries = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Map<string, Set<Listener>>()
// Bumped on clear (lock); a fetch that resolves across a clear must not repopulate.
let generation = 0

// How many Esplora pages of history to fetch per address. The Activity screen
// raises this via loadMoreHistory(); it resets to 1 when that screen unmounts so
// the dashboard and the background poll stay shallow.
let historyPages = 1

const FETCHERS: Record<string, () => Promise<unknown>> = {
  summary: () => wallet.getSummary(),
  history: () => wallet.getHistory(historyPages),
  coins: () => wallet.listCoins(),
  contacts: () => wallet.listContacts(),
  tokens: () => wallet.listTokens(),
}

function emit(key: string): void {
  const set = listeners.get(key)
  if (set !== undefined) for (const l of [...set]) l()
}

function subscribe(key: string, l: Listener): () => void {
  let set = listeners.get(key)
  if (set === undefined) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(l)
  return () => set.delete(l)
}

// Fetch a key unless a fetch is already in flight (dedup). On success the entry is
// replaced (new reference, so subscribers re-render). A failed background refresh
// keeps the existing data and stays silent; a failed first load surfaces the error.
function load<T>(key: string, fetcher: () => Promise<T>): void {
  if (inflight.has(key)) return
  const g = generation
  const p = (async () => {
    try {
      const data = await fetcher()
      if (g === generation) entries.set(key, { data, fetchedAt: Date.now() })
    } catch (err) {
      if (g !== generation) return
      const prev = entries.get(key) as Entry<T> | undefined
      if (prev?.data !== undefined) {
        entries.set(key, { data: prev.data, fetchedAt: prev.fetchedAt })
      } else {
        entries.set(key, { error: err instanceof Error ? err : new Error(String(err)), fetchedAt: 0 })
      }
    } finally {
      inflight.delete(key)
      if (g === generation) emit(key)
    }
  })()
  inflight.set(key, p)
}

// Ensure a key is present and fresh: first load, or a background refresh when the
// cached value has aged past the freshness window.
function ensure<T>(key: string, fetcher: () => Promise<T>): void {
  const e = entries.get(key) as Entry<T> | undefined
  const stale = e === undefined || e.fetchedAt === 0 || Date.now() - e.fetchedAt > FRESH_MS
  if (stale && !inflight.has(key)) load(key, fetcher)
}

export interface WalletData<T> {
  readonly data: T | undefined
  readonly error: Error | undefined
  /** True only before the first value arrives — never during a background refresh. */
  readonly loading: boolean
  /** Force a refetch now (e.g. the Refresh button). */
  readonly refresh: () => void
}

// Subscribe a component to a cached key. Returns the current value immediately
// (instant on revisit) and triggers a fetch/refresh as needed.
export function useWalletData<T>(key: string, fetcher: () => Promise<T>): WalletData<T> {
  const sub = useCallback((l: Listener) => subscribe(key, l), [key])
  const getSnapshot = useCallback(() => entries.get(key) as Entry<T> | undefined, [key])
  const snapshot = useSyncExternalStore(sub, getSnapshot, getSnapshot)

  useEffect(() => {
    ensure(key, fetcher)
  }, [key, fetcher])

  return {
    data: snapshot?.data,
    error: snapshot?.error,
    loading: snapshot?.data === undefined && snapshot?.error === undefined,
    refresh: () => load(key, fetcher),
  }
}

export const useSummary = (): WalletData<WalletSummary> => useWalletData('summary', FETCHERS.summary as () => Promise<WalletSummary>)
export const useHistory = (): WalletData<HistoryPage> => useWalletData('history', FETCHERS.history as () => Promise<HistoryPage>)
export const useCoins = (): WalletData<UtxoView[]> => useWalletData('coins', FETCHERS.coins as () => Promise<UtxoView[]>)
export const useContacts = (): WalletData<readonly Contact[]> => useWalletData('contacts', FETCHERS.contacts as () => Promise<readonly Contact[]>)
export const useTokens = (): WalletData<TokenBalance[]> => useWalletData('tokens', FETCHERS.tokens as () => Promise<TokenBalance[]>)

// ── Wallet list (local registry, not chain data) ───────────────────────────────
// Kept in its own little store so a chain-data wipe (switch) doesn't clear it. It
// changes only via our own mutations (switch/add/rename/remove), which return the
// updated list; the switcher reads it live.
let walletList: readonly WalletInfo[] = []
const walletListeners = new Set<Listener>()

export function useWallets(): readonly WalletInfo[] {
  const sub = useCallback((l: Listener) => {
    walletListeners.add(l)
    return () => walletListeners.delete(l)
  }, [])
  return useSyncExternalStore(sub, () => walletList, () => walletList)
}

// The active wallet (or undefined before the list loads). Screens use this to gate
// signing UI — a watch wallet has canSign === false.
export function useActiveWallet(): WalletInfo | undefined {
  return useWallets().find((w) => w.active)
}

// Replace the wallet list (from listWallets() or a mutation's return value).
export function setWallets(list: readonly WalletInfo[]): void {
  walletList = list
  for (const l of [...walletListeners]) l()
}

// Load the wallet list from main (on shell mount / unlock).
export async function loadWallets(): Promise<void> {
  try {
    setWallets(await wallet.listWallets())
  } catch {
    // Keep the previous list on a transient failure.
  }
}

// ── Node status (shared) ────────────────────────────────────────────────────────
// One source of truth for the connection indicator, consumed by Settings, the title
// bar and the sidebar — so an offline/syncing node is reflected everywhere, not just
// in Settings. Polled while unlocked. `tip` is the highest block height we've ever
// seen (any node), used as the sync target so a catching-up node can show progress
// without querying a third party (the chain height is public, not sensitive).
// `checking` is set during an explicit re-probe after a node change, so the UI can
// show a loader instead of a stale value.
export interface NodeStatusSnapshot {
  readonly status: NodeStatus | null
  readonly checking: boolean
  readonly tip: number
}

// ─── Build network ───────────────────────────────────────────────────
// Which chain this BUILD runs on. A process-lifetime constant reported by
// main (NodeSettings.network): fetched once, then served from cache to every
// consumer (title bar, sidebar footer). null until the first answer arrives.

let buildNetwork: 'mainnet' | 'testnet' | null = null
let buildNetworkPromise: Promise<void> | null = null
const buildNetworkListeners = new Set<Listener>()

function fetchBuildNetwork(): void {
  buildNetworkPromise ??= wallet
    .getNode()
    .then((s) => {
      buildNetwork = s.network
      // The sync-target key is per network: adopt the right persisted value
      // now that we know which one we are. Until this resolves the mainnet
      // key is read — harmless, the tip is a cosmetic sync target.
      setNodeSnap({ tip: readNodeTip() })
      for (const listener of buildNetworkListeners) listener()
    })
    .catch(() => {
      buildNetworkPromise = null // retry on the next mount
    })
}

export function useBuildNetwork(): 'mainnet' | 'testnet' | null {
  const sub = useCallback((l: Listener) => {
    buildNetworkListeners.add(l)
    if (buildNetwork === null) fetchBuildNetwork()
    return () => buildNetworkListeners.delete(l)
  }, [])
  return useSyncExternalStore(sub, () => buildNetwork, () => buildNetwork)
}

/** Display label for a network ('…' while unknown). */
export function networkLabel(network: 'mainnet' | 'testnet' | null): string {
  return network === 'mainnet' ? 'Mainnet' : network === 'testnet' ? 'Testnet' : '…'
}

// Mainnet keeps the historical key (shipped installs must not lose their
// persisted sync target); testnet gets a suffixed key so the two chains'
// heights never mix.
const NODE_TIP_KEY = 'wallet.tipHeight'
function nodeTipKey(): string {
  return buildNetwork === 'testnet' ? `${NODE_TIP_KEY}.testnet` : NODE_TIP_KEY
}
function readNodeTip(): number {
  try {
    const v = Number(window.localStorage.getItem(nodeTipKey()))
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch {
    return 0
  }
}

let nodeSnap: NodeStatusSnapshot = { status: null, checking: false, tip: readNodeTip() }
const nodeListeners = new Set<Listener>()

function setNodeSnap(patch: Partial<NodeStatusSnapshot>): void {
  nodeSnap = { ...nodeSnap, ...patch }
  for (const l of [...nodeListeners]) l()
}

// Bump (and persist) the sync target when a node reports a higher height.
function recordTip(s: NodeStatus): number {
  if (s.blockHeight !== undefined && s.blockHeight > nodeSnap.tip) {
    try {
      window.localStorage.setItem(nodeTipKey(), String(s.blockHeight))
    } catch {
      // Non-fatal: the target just won't persist across restarts.
    }
    return s.blockHeight
  }
  return nodeSnap.tip
}

export function useNodeStatus(): NodeStatusSnapshot {
  const sub = useCallback((l: Listener) => {
    nodeListeners.add(l)
    return () => nodeListeners.delete(l)
  }, [])
  return useSyncExternalStore(sub, () => nodeSnap, () => nodeSnap)
}

// Poll cadence: a healthy node is re-checked often; an unreachable one is backed off
// to once a minute so we don't hammer a dead endpoint. The next-due time gates the
// shared poll loop; an explicit Retry / visibility-return polls immediately regardless.
const NODE_POLL_MS = 30_000
const NODE_OFFLINE_POLL_MS = 60_000
let nodeNextPollAt = 0
function scheduleNextNodePoll(): void {
  nodeNextPollAt = Date.now() + (nodeSnap.status?.reachable === true ? NODE_POLL_MS : NODE_OFFLINE_POLL_MS)
}
function nodePollDue(): boolean {
  return nodeListeners.size > 0 && Date.now() >= nodeNextPollAt
}

// Background poll — keeps the last value while in flight (no loader). Deduped.
let nodePollInflight = false
export async function pollNode(): Promise<void> {
  if (nodePollInflight) return
  nodePollInflight = true
  try {
    const s = await wallet.nodeStatus()
    setNodeSnap({ status: s, tip: recordTip(s) })
  } catch {
    // Keep the last value on a transient failure.
  } finally {
    nodePollInflight = false
    scheduleNextNodePoll()
  }
}

// Explicit re-probe — after a node change or a manual Retry. Clears the (now stale)
// value and shows a loader while the endpoint answers, which can be slow for a fresh
// or recovering node.
export async function probeNode(): Promise<void> {
  setNodeSnap({ checking: true, status: null })
  try {
    const s = await wallet.nodeStatus()
    setNodeSnap({ status: s, tip: recordTip(s), checking: false })
  } catch {
    setNodeSnap({ checking: false })
  } finally {
    scheduleNextNodePoll()
  }
}

// The connection-dot colour shared by the title bar, sidebar and Settings.
export function nodeDotColor(snap: NodeStatusSnapshot): string {
  if (snap.checking || snap.status === null) return 'var(--ink-300)'
  if (snap.status.reachable !== true) return 'var(--danger)'
  if (snap.status.syncing === true) return 'var(--warning)'
  return 'var(--success)'
}

// Sync progress (1–99%) when the node is catching up and we have a higher reference
// height; null when synced, unknown, or no reference yet.
export function nodeSyncPercent(snap: NodeStatusSnapshot): number | null {
  const s = snap.status
  if (s === null || s.syncing !== true || s.blockHeight === undefined || s.blockHeight < 0) return null
  if (snap.tip > s.blockHeight) return Math.min(99, Math.max(1, Math.floor((s.blockHeight / snap.tip) * 100)))
  return null
}

// Seed the cache from main's persisted snapshot (called once on unlock) so the
// dashboard renders the last-known balance/history/tokens instantly. Each seeded
// value is marked stale, so the normal read still refreshes it in the background.
// It never clobbers a value already fetched this session, and bails if a lock
// (generation bump) happened while the snapshot was loading.
export async function hydrateFromSnapshot(): Promise<void> {
  const g = generation
  let snap: WalletSnapshot | null
  try {
    snap = await wallet.getSnapshot()
  } catch {
    return
  }
  if (snap === null || g !== generation) return
  const staleAt = Date.now() - FRESH_MS - 1
  const seed = (key: string, data: unknown): void => {
    if (data === undefined || entries.get(key)?.data !== undefined) return
    entries.set(key, { data, fetchedAt: staleAt })
    emit(key)
  }
  seed('summary', snap.summary)
  seed('history', snap.history)
  seed('tokens', snap.tokens)
}

// Mark keys stale and, for any pane currently showing them, revalidate now (so a
// mutation is reflected without waiting for a navigation). Call after actions that
// change chain state: a send invalidates summary/history/coins, etc.
export function invalidate(...keys: string[]): void {
  for (const key of keys) {
    const e = entries.get(key)
    if (e !== undefined) entries.set(key, { ...e, fetchedAt: 0 })
    const mounted = (listeners.get(key)?.size ?? 0) > 0
    const fetcher = FETCHERS[key]
    if (mounted && fetcher !== undefined) load(key, fetcher)
    else emit(key)
  }
}

// Refresh everything currently on screen (the header Refresh button).
export function refreshAll(): void {
  for (const key of Object.keys(FETCHERS)) invalidate(key)
}

// Wipe the chain caches and reload what's on screen when the active wallet changes —
// its balances/history/coins/tokens all differ. Seeds from the new wallet's snapshot
// for an instant repaint, then refreshes the visible panes. The wallet list itself is
// left intact (the switch already updated it).
export function resetWalletData(): void {
  clearAll()
  void hydrateFromSnapshot()
  refreshVisible()
}

// Activity's "load more": deepen the history fetch by one page and refresh. Returns
// when the deeper fetch settles, so the caller can show a loading state. If a refresh
// is already mid-flight (e.g. the poll), it waits for it before fetching deeper, so
// the raised page count actually takes effect.
export function loadMoreHistory(): Promise<void> {
  historyPages += 1
  const pending = inflight.get('history')
  if (pending !== undefined) {
    return pending.then(() => {
      load('history', FETCHERS.history)
      return inflight.get('history') ?? Promise.resolve()
    })
  }
  load('history', FETCHERS.history)
  return inflight.get('history') ?? Promise.resolve()
}

// Return history to its default single page (e.g. when leaving Activity), so the
// dashboard and the 30s poll don't keep re-fetching deep history.
export function resetHistoryPages(): void {
  historyPages = 1
}

// Optimistically transform the cached coin list (e.g. label/freeze edits) so the
// UI updates instantly; the caller persists via main and invalidates on failure.
export function mutateCoins(updater: (prev: readonly UtxoView[]) => UtxoView[]): void {
  const e = entries.get('coins') as Entry<UtxoView[]> | undefined
  if (e?.data === undefined) return
  entries.set('coins', { data: updater(e.data), fetchedAt: e.fetchedAt })
  emit('coins')
}

// Optimistically transform the cached history (e.g. a tx-label edit) so the UI
// updates instantly; the caller persists via main and refreshes on failure.
export function mutateHistory(updater: (prev: readonly HistoryItem[]) => HistoryItem[]): void {
  const e = entries.get('history') as Entry<HistoryPage> | undefined
  if (e?.data === undefined) return
  entries.set('history', { data: { ...e.data, items: updater(e.data.items) }, fetchedAt: e.fetchedAt })
  emit('history')
}

// Per-txid detail cache for the drawer. A transaction's inputs/outputs are
// immutable, so once fetched it's reused on reopen (no second round-trip); an
// in-flight map dedups concurrent opens of the same tx (e.g. a double-invoked
// effect). Cleared on lock.
const txDetails = new Map<string, TxDetail>()
const txDetailInflight = new Map<string, Promise<TxDetail>>()
export async function loadTxDetail(txid: string): Promise<TxDetail> {
  const hit = txDetails.get(txid)
  if (hit !== undefined) return hit
  const pending = txDetailInflight.get(txid)
  if (pending !== undefined) return pending
  const p = wallet
    .getTxDetail(txid)
    .then((detail) => {
      txDetails.set(txid, detail)
      txDetailInflight.delete(txid)
      return detail
    })
    .catch((e: unknown) => {
      txDetailInflight.delete(txid)
      throw e
    })
  txDetailInflight.set(txid, p)
  return p
}

// Per-txid raw-hex cache for the advanced view. The serialized tx is immutable, so
// it's fetched at most once per tx and reused; an in-flight map dedups concurrent
// requests, and it's cleared on lock alongside the detail cache.
const txRaws = new Map<string, string>()
const txRawInflight = new Map<string, Promise<string>>()
export async function loadTxRaw(txid: string): Promise<string> {
  const hit = txRaws.get(txid)
  if (hit !== undefined) return hit
  const pending = txRawInflight.get(txid)
  if (pending !== undefined) return pending
  const p = wallet
    .getTxRaw(txid)
    .then((hex) => {
      txRaws.set(txid, hex)
      txRawInflight.delete(txid)
      return hex
    })
    .catch((e: unknown) => {
      txRawInflight.delete(txid)
      throw e
    })
  txRawInflight.set(txid, p)
  return p
}

// Persist a transaction label: update the history cache optimistically, then write
// through main (reverting via a refetch on failure). Shared by the activity rows
// and the detail drawer.
export function saveTxLabel(txid: string, value: string): void {
  const trimmed = value.trim()
  mutateHistory((items) => items.map((it) => (it.txid === txid ? { ...it, label: trimmed === '' ? undefined : trimmed } : it)))
  void wallet.setTxLabel(txid, trimmed).catch(() => invalidate('history'))
}

// Write the contacts list straight into the cache. addContact/removeContact in
// main already return the updated list, so there's no need to refetch it.
export function setContacts(list: readonly Contact[]): void {
  entries.set('contacts', { data: list, fetchedAt: Date.now() })
  emit('contacts')
}

// Drop everything when the vault is no longer unlocked. Bumping the generation
// makes any in-flight fetch discard its result instead of repopulating the cache.
function clearAll(): void {
  generation += 1
  historyPages = 1
  entries.clear()
  inflight.clear()
  txDetails.clear()
  txDetailInflight.clear()
  txRaws.clear()
  txRawInflight.clear()
  for (const key of [...listeners.keys()]) emit(key)
}

wallet.onStatusChanged((status) => {
  if (status === 'unlocked') {
    void pollNode()
  } else {
    clearAll()
    setWallets([])
    setNodeSnap({ status: null, checking: false })
  }
})

// Keep on-screen data live without user action: every POLL_MS, refresh whatever
// read models are currently subscribed. Unmounted panes (and a locked vault, whose
// panes unmount) have no subscribers and are skipped, so this only re-hits the node
// for what's actually visible. Polling pauses while the window is hidden and fires
// once on return, so a backgrounded app doesn't keep querying.
const POLL_MS = 30_000

function refreshVisible(): void {
  for (const [key, set] of listeners) {
    if (set.size === 0) continue
    const fetcher = FETCHERS[key]
    if (fetcher !== undefined) load(key, fetcher)
  }
}

// Survive dev hot-reload: tear down the previous module instance's timer/listener
// before installing this one, so they don't pile up. In a production build this
// runs exactly once.
const w = window as typeof window & { __ecrPoll?: { timer: ReturnType<typeof setInterval>; onVisible: () => void } }
if (w.__ecrPoll !== undefined) {
  clearInterval(w.__ecrPoll.timer)
  document.removeEventListener('visibilitychange', w.__ecrPoll.onVisible)
}
const onVisible = (): void => {
  if (!document.hidden) {
    refreshVisible()
    // Returning to the app → check the node now, regardless of the backoff timer.
    if (nodeListeners.size > 0) void pollNode()
  }
}
const timer = setInterval(() => {
  if (!document.hidden) {
    refreshVisible()
    if (nodePollDue()) void pollNode()
  }
}, POLL_MS)
document.addEventListener('visibilitychange', onVisible)
w.__ecrPoll = { timer, onVisible }
