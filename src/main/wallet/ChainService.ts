import { balanceOf, type ChainTx, type FeeEstimates, type TokenInfo } from '@qbtc/chain'
import { btcAddressFromScriptPubKey, fromHex, type BtcNetwork } from '@qbtc/crypto'
import {
  discoverBranch,
  isActive,
  type AddressLookup,
  type Algo,
  type DiscoveredAddress,
  type DiscoveryBranch,
} from './discovery'
import type { ActiveAddress } from './spendable'
import type { AddressAlgo, FeeBands, HistoryItem, HistoryPage, TokenBalance, TxDetail, TxIoEntry, WalletSummary } from '../../shared/protocol'

/** What discovery learned about one of our addresses: the branch's signature
 *  algorithm and (when the branch is HD-derived) its derivation scheme id. */
interface AddressTag {
  readonly algo: Algo
  readonly scheme?: string
}

// The chain backend the service needs. The real ChainClient satisfies it; tests
// pass a fake, so the service is exercised without any network.
export interface ChainBackend extends AddressLookup {
  getBlockchainInfo(): Promise<{ tipHeight: number; tipHash: string; network: string }>
  getAddressTransactions(address: string, afterTxid?: string): Promise<ChainTx[]>
  getTransaction(txid: string): Promise<ChainTx>
  getTransactionHex(txid: string): Promise<string>
  getFeeEstimates(): Promise<FeeEstimates>
  getTokenInfo(id: string): Promise<TokenInfo>
}

// Aggregates chain reads for the wallet: balance, history and fee bands over the
// wallet's discovered addresses. Atomic amounts are bigint internally and become
// strings at the boundary (BigInt doesn't belong in display state).
export class ChainService {
  constructor(
    private readonly backend: ChainBackend,
    // The wallet's discovery branches (classical + any PQ), derivable or fixed.
    // Re-read on each discovery so issued-index floors stay current.
    private readonly branches: () => Promise<readonly DiscoveryBranch[]>,
    // Which source-chain network a downgrade payout script encodes to (the
    // native network maps 1:1 to the BTC side). Optional: without it the
    // detail view shows the raw scriptPubKey instead of an address.
    private readonly opts: { readonly btcNetwork?: BtcNetwork } = {},
  ) {}

  async getSummary(): Promise<WalletSummary> {
    const [discovered, info] = await Promise.all([this.discover(), this.backend.getBlockchainInfo()])
    let total = 0n
    for (const d of discovered) total += balanceOf(d.info)
    return {
      balanceAtomic: total.toString(),
      tipHeight: info.tipHeight,
      addressCount: discovered.length,
    }
  }

  async getHistory(pages = 1): Promise<HistoryPage> {
    const discovered = await this.discover()
    const ours = new Set(discovered.map((d) => d.address))
    const active = discovered.filter((x) => isActive(x.info))

    // Esplora pages transactions per address (older pages keyed by the last confirmed
    // txid), so each active address is walked independently and in parallel, up to
    // `pages` pages. An address still returning confirmed txs at the page limit may
    // have older ones — that's surfaced as `hasMore` so the UI can offer "load more".
    const perAddress = await Promise.all(
      active.map(async (d) => {
        const collected: ChainTx[] = []
        let afterTxid: string | undefined
        let mightHaveMore = false
        for (let page = 0; page < pages; page++) {
          const batch = await this.backend.getAddressTransactions(d.address, afterTxid)
          collected.push(...batch)
          const confirmed = batch.filter((tx) => tx.status.confirmed)
          if (confirmed.length === 0) {
            mightHaveMore = false
            break
          }
          afterTxid = confirmed[confirmed.length - 1]!.txid
          mightHaveMore = true
        }
        return { collected, mightHaveMore }
      }),
    )

    // A transaction can touch several of our addresses — dedupe by txid.
    const byTxid = new Map<string, ChainTx>()
    let hasMore = false
    for (const { collected, mightHaveMore } of perAddress) {
      for (const tx of collected) byTxid.set(tx.txid, tx)
      if (mightHaveMore) hasMore = true
    }

    const raw = [...byTxid.values()].map((tx) => this.toHistoryItem(tx, ours))

    // Attach token metadata (cached, so usually free) to the token rows: a compact
    // ticker for display and the authoritative decimals from the token's info.
    const tokenIds = [...new Set(raw.map((i) => i.tokenId).filter((id): id is string => id !== undefined))]
    const infoById = new Map(await Promise.all(tokenIds.map(async (id) => [id, await this.resolveTokenInfo(id)] as const)))
    const items = raw.map((i) => {
      if (i.tokenId === undefined) return i
      const info = infoById.get(i.tokenId)
      return info === undefined ? i : { ...i, tokenTicker: tickerOf(info), tokenDecimals: info.decimals }
    })

    // Newest first; unconfirmed (no height) on top.
    items.sort((a, b) => (b.blockHeight ?? Number.MAX_SAFE_INTEGER) - (a.blockHeight ?? Number.MAX_SAFE_INTEGER))
    return { items, hasMore }
  }

  // Full detail for one transaction: confirmations, size, totals and the resolved
  // input/output lists with our addresses (and post-quantum ones) marked. Fetched
  // on demand when the detail drawer opens.
  async getTxDetail(txid: string): Promise<TxDetail> {
    const [tx, tip, byAlgo] = await Promise.all([this.backend.getTransaction(txid), this.tipHeight(), this.discoverByAlgo()])
    const confirmations = tx.status.confirmed && tx.status.blockHeight !== undefined ? Math.max(0, tip - tx.status.blockHeight + 1) : 0
    const entry = (address: string | undefined, value: bigint, tokenId?: string, tokenAmount?: bigint): MutableIoEntry => {
      const tag = address !== undefined ? byAlgo.get(address) : undefined
      const e: MutableIoEntry = {
        amountAtomic: value.toString(),
        own: tag !== undefined,
        pq: tag?.algo === 'falcon512',
      }
      if (address !== undefined) e.address = address
      if (tokenId !== undefined) {
        e.tokenId = tokenId
        e.tokenAmountAtomic = (tokenAmount ?? 0n).toString()
      }
      return e
    }
    // Inputs carry, beyond the resolved amount/address, the outpoint they spend and
    // the on-chain unlocking detail (scripthash, redeem script, signature scheme) —
    // surfaced only in advanced mode but always populated here.
    const inputs = tx.vin.map((v) => {
      const e = entry(v.prevoutAddress, v.prevoutValue ?? 0n, v.prevoutTokenId, v.prevoutTokenAmount)
      e.prevoutTxid = v.txid
      e.prevoutVout = v.vout
      if (v.prevoutScripthash !== undefined) e.scripthash = v.prevoutScripthash
      if (v.redeemScript !== undefined) e.redeemScript = v.redeemScript
      if (v.siglist !== undefined && v.siglist.length > 0) {
        e.siglist = v.siglist
        e.sigScheme = sigSchemeOf(v.siglist[0]!)
      }
      return e
    })
    const outputs = tx.vout.map((o) => {
      const e = entry(o.address, o.value, o.tokenId, o.tokenAmount)
      if (o.scripthash !== '') e.scripthash = o.scripthash
      return e
    })
    const detail: MutableTxDetail = {
      txid: tx.txid,
      confirmations,
      sizeBytes: tx.size,
      totalInAtomic: tx.vin.reduce((s, v) => s + (v.prevoutValue ?? 0n), 0n).toString(),
      totalOutAtomic: tx.vout.reduce((s, o) => s + o.value, 0n).toString(),
      feeAtomic: tx.fee.toString(),
      inputs,
      outputs,
      txType: tx.version,
    }
    if (tx.status.blockHash !== undefined) detail.blockHash = tx.status.blockHash
    if (tx.status.blockHeight !== undefined) detail.blockHeight = tx.status.blockHeight
    if (tx.status.blockPos !== undefined) detail.blockPos = tx.status.blockPos
    if (tx.isCoinbase !== undefined) detail.isCoinbase = tx.isCoinbase
    if (tx.txTypeName !== undefined) detail.txTypeName = tx.txTypeName
    if (tx.downgradeInfo !== undefined) {
      const d = tx.downgradeInfo
      const info: NonNullable<MutableTxDetail['downgradeInfo']> = { btcTxid: d.btcTxid }
      if (d.freezeTxid !== undefined) info.freezeTxid = d.freezeTxid
      if (d.freezeVout !== undefined) info.freezeVout = d.freezeVout
      if (d.btcVout !== undefined) info.btcVout = d.btcVout
      if (d.btcValueSat !== undefined) info.btcValueSat = d.btcValueSat.toString()
      if (d.btcScriptPubKey !== undefined) {
        info.btcScriptPubKey = d.btcScriptPubKey
        if (this.opts.btcNetwork !== undefined) {
          // Show WHERE the payout goes when the committed script is a
          // standard template; nonstandard stays as hex.
          try {
            const addr = btcAddressFromScriptPubKey(fromHex(d.btcScriptPubKey), this.opts.btcNetwork)
            if (addr !== undefined) info.btcAddress = addr
          } catch {
            // Malformed hex from the node — the raw field is still shown.
          }
        }
      }
      if (d.btcBlockHash !== undefined) info.btcBlockHash = d.btcBlockHash
      detail.downgradeInfo = info
    }
    if (tx.coinbaseInfo !== undefined) {
      detail.coinbaseInfo = {
        btcTxid: tx.coinbaseInfo.btcTxid,
        btcBlockHeight: tx.coinbaseInfo.btcBlockHeight,
        btcOutNum: tx.coinbaseInfo.btcOutNum,
        valueSat: tx.coinbaseInfo.valueSat.toString(),
      }
    }
    return detail
  }

  /** Raw serialized transaction, hex. Fetched lazily by the advanced view (a
   *  separate round-trip, so the normal detail open stays cheap). */
  async getTxRaw(txid: string): Promise<string> {
    return this.backend.getTransactionHex(txid)
  }

  async estimateFee(): Promise<FeeBands> {
    const est = await this.backend.getFeeEstimates()
    return {
      fast: pick(est, ['1', '2', '3']) ?? 1,
      medium: pick(est, ['6', '5', '4', '3']) ?? 1,
      slow: pick(est, ['144', '72', '36', '24']) ?? 1,
    }
  }

  // Tokens the wallet holds: sum each token's balance across the discovered
  // addresses (the node reports a per-address token map), then attach metadata.
  async listTokens(): Promise<TokenBalance[]> {
    const discovered = await this.discover()
    const sums = new Map<string, bigint>()
    for (const d of discovered) {
      for (const [id, amount] of Object.entries(d.info.tokens)) {
        if (amount > 0n) sums.set(id, (sums.get(id) ?? 0n) + amount)
      }
    }
    const balances: TokenBalance[] = []
    for (const [id, amount] of sums) {
      if (amount <= 0n) continue
      const info = await this.resolveTokenInfo(id)
      balances.push({ id, amountAtomic: amount.toString(), decimals: info.decimals, symbol: info.symbol, name: info.name })
    }
    // Stable order: by symbol, falling back to the id when metadata is unknown.
    balances.sort((a, b) => (a.symbol ?? a.id).localeCompare(b.symbol ?? b.id))
    return balances
  }

  // Token metadata is public and stable, so it's cached per session. A failed
  // lookup falls back to the node's default 6 decimals (unknown symbol/name) and
  // is not cached, so it retries on the next call.
  private readonly tokenInfoCache = new Map<string, TokenInfo>()
  private async resolveTokenInfo(id: string): Promise<{ decimals: number; symbol?: string; name?: string }> {
    const hit = this.tokenInfoCache.get(id)
    if (hit !== undefined) return hit
    try {
      const info = await this.backend.getTokenInfo(id)
      this.tokenInfoCache.set(id, info)
      return info
    } catch {
      return { decimals: 6 }
    }
  }

  private toHistoryItem(tx: ChainTx, ours: ReadonlySet<string>): HistoryItem {
    let received = 0n
    for (const out of tx.vout) {
      if (out.address !== undefined && ours.has(out.address)) received += out.value
    }
    let sent = 0n
    for (const input of tx.vin) {
      if (input.prevoutAddress !== undefined && input.prevoutValue !== undefined && ours.has(input.prevoutAddress)) {
        sent += input.prevoutValue
      }
    }
    const net = received - sent
    const outgoing = net < 0n
    const item: HistoryItem = {
      txid: tx.txid,
      direction: outgoing ? 'out' : 'in',
      amountAtomic: (outgoing ? -net : net).toString(),
      feeAtomic: tx.fee.toString(),
      confirmed: tx.status.confirmed,
      blockHeight: tx.status.blockHeight,
      blockTime: tx.status.blockTime,
      // Non-standard types surface as a badge on the row (1 = standard is
      // implied; 4 = tokens already reads as its ticker headline).
      ...(tx.version !== 1 && tx.version !== 4 ? { txType: tx.version } : {}),
    }
    // A token transfer drives its own direction and headline; the native side of a
    // token tx is just the fee (a send) or zero (a receive). The ticker is attached
    // later in getHistory, once the token's metadata is resolved.
    const token = tokenMovement(tx, ours)
    if (token !== null) {
      return { ...item, direction: token.direction, tokenId: token.tokenId, tokenAmountAtomic: token.amount.toString(), tokenDecimals: token.decimals }
    }
    return item
  }

  // address → its branch tag (signature algo + derivation scheme id), populated as
  // a side effect of discover() (which every balance/history read already runs).
  // The detail view reuses this rather than triggering its own discovery, so opening
  // it is instant once the dashboard or Activity has loaded. It only forces a
  // discovery if nothing ran recently.
  private algoMemo: { at: number; map: Map<string, AddressTag> } | null = null
  private async discoverByAlgo(): Promise<Map<string, AddressTag>> {
    if (this.algoMemo !== null && Date.now() - this.algoMemo.at < 60_000) return this.algoMemo.map
    await this.discover() // populates algoMemo
    return this.algoMemo?.map ?? new Map<string, AddressTag>()
  }

  /** Warm the address index off the critical path (called on unlock) so the first
   *  transaction-detail open doesn't pay for a discovery. */
  async prewarmAddressIndex(): Promise<void> {
    await this.discoverByAlgo()
  }

  // The wallet's active addresses (those with history), tagged with their algorithm
  // and derivation scheme, for the spend pool to pull UTXOs from. Reuses the shared
  // discover() pass so it doesn't trigger a second address scan — the chain reads
  // and the pool now share one gap-scan per load.
  async spendableAddresses(): Promise<ActiveAddress[]> {
    const discovered = await this.discover()
    const byAlgo = this.algoMemo?.map
    return discovered
      .filter((d) => isActive(d.info))
      .map((d) => {
        const tag = byAlgo?.get(d.address)
        const base: ActiveAddress = { address: d.address, chain: d.chain, index: d.index, algo: tag?.algo ?? 'ecdsa' }
        return tag?.scheme !== undefined ? { ...base, scheme: tag.scheme } : base
      })
  }

  // Tip height, cached briefly. Blocks are ~10s apart, so a few seconds of staleness
  // doesn't change confirmation counts meaningfully and saves a round-trip on each
  // transaction-detail open.
  private tipMemo: { at: number; height: number } | null = null
  private async tipHeight(): Promise<number> {
    if (this.tipMemo !== null && Date.now() - this.tipMemo.at < 8_000) return this.tipMemo.height
    const { tipHeight } = await this.backend.getBlockchainInfo()
    this.tipMemo = { at: Date.now(), height: tipHeight }
    return tipHeight
  }

  // Concurrent callers (a dashboard load fires getSummary + getHistory + listTokens
  // at once) share a single in-flight discovery instead of each re-scanning every
  // address. A later call (manual refresh, the 30s poll) starts a fresh one.
  private discoverInflight: Promise<DiscoveredAddress[]> | null = null
  private async discover(): Promise<DiscoveredAddress[]> {
    if (this.discoverInflight !== null) return this.discoverInflight
    const p = this.runDiscover()
    this.discoverInflight = p
    // Clear the slot once it settles, either way. The rejection handler also marks
    // p's rejection as observed on this branch (e.g. discovery attempted right after
    // a lock); each real caller still handles its own awaited result.
    const clear = (): void => {
      if (this.discoverInflight === p) this.discoverInflight = null
    }
    void p.then(clear, clear)
    return p
  }

  private async runDiscover(): Promise<DiscoveredAddress[]> {
    // Discover every branch in parallel, tagging each found address with its branch's
    // algorithm + derivation scheme so the address→tag map is built in the same pass
    // (reused by the spend pool — which needs the scheme to sign on the right path —
    // and the detail view).
    const branches = await this.branches()
    const results = await Promise.all(
      branches.map(async (b) => ({ algo: b.algo, scheme: b.scheme, found: await discoverBranch(b, this.backend) })),
    )
    const map = new Map<string, AddressTag>()
    const all: DiscoveredAddress[] = []
    for (const { algo, scheme, found } of results) {
      for (const d of found) map.set(d.address, scheme !== undefined ? { algo, scheme } : { algo })
      all.push(...found)
    }
    this.algoMemo = { at: Date.now(), map }
    return all
  }
}

// The net token movement a transaction represents for our wallet, or null when it
// moves no token. A token output to one of our addresses is a receive; if we own an
// input (we spent), it's a send and the amount is what went to other addresses
// (token change back to us is ignored). Picks the dominant token when several move
// — the common case is a single token per transaction.
function tokenMovement(tx: ChainTx, ours: ReadonlySet<string>): { tokenId: string; amount: bigint; decimals: number; direction: 'in' | 'out' } | null {
  const toUs = new Map<string, bigint>()
  const toOthers = new Map<string, bigint>()
  const decimalsById = new Map<string, number>()
  for (const out of tx.vout) {
    if (out.tokenId === undefined || out.tokenAmount === undefined) continue
    const bucket = out.address !== undefined && ours.has(out.address) ? toUs : toOthers
    bucket.set(out.tokenId, (bucket.get(out.tokenId) ?? 0n) + out.tokenAmount)
    if (out.tokenDecimals !== undefined) decimalsById.set(out.tokenId, out.tokenDecimals)
  }
  if (toUs.size === 0 && toOthers.size === 0) return null
  const weSpent = tx.vin.some((i) => i.prevoutAddress !== undefined && ours.has(i.prevoutAddress))
  const largest = (m: Map<string, bigint>): { tokenId: string; amount: bigint } | null => {
    let best: { tokenId: string; amount: bigint } | null = null
    for (const [tokenId, amount] of m) if (best === null || amount > best.amount) best = { tokenId, amount }
    return best
  }
  if (weSpent) {
    const sent = largest(toOthers)
    if (sent !== null) return { ...sent, decimals: decimalsById.get(sent.tokenId) ?? 6, direction: 'out' }
  }
  const received = largest(toUs)
  if (received !== null) return { ...received, decimals: decimalsById.get(received.tokenId) ?? 6, direction: 'in' }
  return null
}

// The compact ticker for a token (e.g. "USDT"). The node's metadata isn't
// consistent about which of symbol/name holds the short label, so pick the shorter.
function tickerOf(info: { symbol?: string; name?: string }): string {
  const both = [info.symbol, info.name].map((x) => x?.trim()).filter((x): x is string => x !== undefined && x.length > 0)
  if (both.length === 0) return 'Token'
  if (both.length === 1) return both[0]
  return both[0].length <= both[1].length ? both[0] : both[1]
}

/** First present numeric fee rate among `keys`, or undefined. */
function pick(est: FeeEstimates, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = est[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

// Mutable builders for the readonly protocol types: getTxDetail assembles each
// entry, attaches the optional advanced fields, then returns it as TxIoEntry/TxDetail.
type MutableIoEntry = {
  amountAtomic: string
  address?: string
  own: boolean
  pq: boolean
  tokenId?: string
  tokenAmountAtomic?: string
  scripthash?: string
  prevoutTxid?: string
  prevoutVout?: number
  redeemScript?: string
  sigScheme?: AddressAlgo | 'unknown'
  siglist?: readonly string[]
}

type MutableTxDetail = {
  txid: string
  confirmations: number
  sizeBytes: number
  totalInAtomic: string
  totalOutAtomic: string
  feeAtomic: string
  inputs: readonly TxIoEntry[]
  outputs: readonly TxIoEntry[]
  txType?: number
  blockHash?: string
  blockHeight?: number
  blockPos?: number
  isCoinbase?: boolean
  txTypeName?: string
  coinbaseInfo?: { btcTxid: string; btcBlockHeight: number; btcOutNum: number; valueSat: string }
  downgradeInfo?: {
    btcTxid: string
    freezeTxid?: string
    freezeVout?: number
    btcVout?: number
    btcValueSat?: string
    btcAddress?: string
    btcScriptPubKey?: string
    btcBlockHash?: string
  }
}

// Signature scheme of a siglist entry, read from its algo byte. Hex layout is
// `<sighash:1><algo:1><signature…>`; algo 1 = ECDSA, 2 = Schnorr, 129 (0x81) =
// Falcon-512.
function sigSchemeOf(entry: string): AddressAlgo | 'unknown' {
  if (entry.length < 4) return 'unknown'
  const algo = Number.parseInt(entry.slice(2, 4), 16)
  if (algo === 1) return 'ecdsa'
  if (algo === 2) return 'schnorr'
  if (algo === 129) return 'falcon512'
  return 'unknown'
}
