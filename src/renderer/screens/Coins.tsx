import { useState, type ReactNode } from 'react'
import type { UtxoView } from '../../shared/protocol'
import { formatNative, formatToken, tokenLabels } from '../lib/format'
import { wallet } from '../lib/wallet'
import { invalidate, mutateCoins, useAssetLabel, useCoins, useTokens } from '../lib/walletData'
import { Button, CheckIcon, PencilIcon, Pill, Screen, SearchIcon, SendIcon, SnowIcon } from '../ui'

type Filter = 'all' | 'spendable' | 'frozen' | 'tokens'
const FILTERS: readonly (readonly [Filter, string])[] = [
  ['all', 'All'],
  ['spendable', 'Spendable'],
  ['frozen', 'Frozen'],
  ['tokens', 'Tokens'],
]

// Display label for a token UTXO's amount, resolved from the token list.
type TokenAsset = { ticker: string; decimals: number }

// Coin control: the wallet's UTXOs with per-coin label, freeze, and selection.
// The renderer reads the inventory from main and applies changes through it; it
// holds no keys. Selecting coins and pressing "Send selected" hands the chosen
// outpoints to the send flow, which spends exactly those.
export function Coins({ onSendSelected }: { onSendSelected: (outpoints: string[]) => void }) {
  const { data: coinsData, error: loadError } = useCoins()
  const { data: tokensData } = useTokens()
  const coins = coinsData ?? null
  const tokenById = new Map((tokensData ?? []).map((t) => [t.id, t] as const))
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const asset = useAssetLabel()

  // Optimistic edit of the shared coin list; on a failed write we reload the
  // truth from the node (invalidate), which also reverts the optimistic change.
  function patch(outpoint: string, change: Partial<UtxoView>): void {
    mutateCoins((prev) => prev.map((c) => (c.outpoint === outpoint ? { ...c, ...change } : c)))
  }

  function toggleSelect(outpoint: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(outpoint)) next.delete(outpoint)
      else next.add(outpoint)
      return next
    })
  }

  async function saveLabel(outpoint: string, label: string): Promise<void> {
    const trimmed = label.trim()
    patch(outpoint, { label: trimmed === '' ? undefined : trimmed })
    try {
      await wallet.setUtxoLabel(outpoint, trimmed)
    } catch (e) {
      setError((e as Error).message)
      invalidate('coins')
    }
  }

  async function setFrozen(coin: UtxoView, frozen: boolean): Promise<void> {
    if (coin.frozen === frozen) return
    patch(coin.outpoint, { frozen })
    // Freezing a coin protects it from spending, so it can no longer be selected.
    if (frozen) {
      setSelected((prev) => {
        if (!prev.has(coin.outpoint)) return prev
        const next = new Set(prev)
        next.delete(coin.outpoint)
        return next
      })
    }
    try {
      await wallet.setUtxoFrozen(coin.outpoint, frozen)
    } catch (e) {
      setError((e as Error).message)
      invalidate('coins')
    }
  }

  async function freezeSelected(): Promise<void> {
    for (const c of list.filter((x) => selected.has(x.outpoint) && !x.frozen)) {
      await setFrozen(c, true)
    }
  }

  const list = coins ?? []
  const shownError = error ?? loadError?.message ?? null
  // Native stats are native-only: a token UTXO has a zero native value and is shown as
  // its own row, never counted as spendable/frozen native value or as a native coin.
  const nativeCoins = list.filter((c) => c.tokenId === undefined)
  const total = nativeCoins.reduce((sum, c) => sum + BigInt(c.valueAtomic), 0n)
  const frozenTotal = nativeCoins.filter((c) => c.frozen).reduce((sum, c) => sum + BigInt(c.valueAtomic), 0n)
  const selectedTotal = nativeCoins.filter((c) => selected.has(c.outpoint)).reduce((sum, c) => sum + BigInt(c.valueAtomic), 0n)

  const q = search.trim().toLowerCase()
  const filtered = list.filter((c) => {
    if (filter === 'spendable' && c.frozen) return false
    if (filter === 'frozen' && !c.frozen) return false
    if (filter === 'tokens' && c.tokenId === undefined) return false
    if (q !== '' && !(c.address.toLowerCase().includes(q) || (c.label ?? '').toLowerCase().includes(q))) return false
    return true
  })

  return (
    <Screen>
      <div style={{ padding: 40, maxWidth: 880, width: '100%', margin: '0 auto' }}>
        {/* Stats */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 18 }}>
          <StatCard label="Spendable" value={formatNative((total - frozenTotal).toString())} unit minWidth={160} />
          <StatCard label="Frozen" value={formatNative(frozenTotal.toString())} unit minWidth={160} tone="frozen" icon={<SnowIcon size={13} />} />
          <StatCard label="Coins" value={String(nativeCoins.length)} minWidth={120} />
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map(([key, label]) => {
              const active = filter === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  style={{ padding: '7px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 500, cursor: 'pointer', border: active ? '1px solid transparent' : '1px solid var(--border-s)', background: active ? 'var(--primary)' : 'transparent', color: active ? '#fff' : 'var(--ink-700)' }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--well)', minWidth: 200 }}>
            <span style={{ display: 'flex', color: 'var(--ink-500)' }}>
              <SearchIcon size={16} />
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search label or address"
              aria-label="Search coins"
              style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', color: 'var(--ink-900)', fontSize: 13, outline: 'none' }}
            />
          </div>
        </div>

        {shownError !== null && (
          <div className="field-hint field-hint--error" style={{ marginBottom: 12 }}>
            {shownError}
          </div>
        )}

        {/* List */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
          {coins === null ? (
            <div style={{ padding: '24px 18px', fontSize: 13, color: 'var(--ink-500)' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--ink-500)' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-700)' }}>No coins yet</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Nothing matches this filter. Receive {asset} to create your first UTXO.</div>
            </div>
          ) : (
            filtered.map((coin) => {
              const tb = coin.tokenId !== undefined ? tokenById.get(coin.tokenId) : undefined
              const tokenAsset: TokenAsset | undefined =
                coin.tokenId !== undefined ? { ticker: tb !== undefined ? tokenLabels(tb).ticker : 'Token', decimals: tb?.decimals ?? 6 } : undefined
              return (
                <CoinRow
                  key={coin.outpoint}
                  coin={coin}
                  tokenAsset={tokenAsset}
                  selected={selected.has(coin.outpoint)}
                  onToggleSelect={() => toggleSelect(coin.outpoint)}
                  onLabel={(l) => void saveLabel(coin.outpoint, l)}
                  onToggleFreeze={() => void setFrozen(coin, !coin.frozen)}
                />
              )
            })
          )}
        </div>

        {/* Floating selection bar */}
        {selected.size > 0 && (
          <div style={{ position: 'sticky', bottom: 26, display: 'flex', justifyContent: 'center', marginTop: 24, pointerEvents: 'none' }}>
            <div style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 14, padding: '10px 12px 10px 18px', borderRadius: 14, background: 'var(--card-el)', border: '1px solid var(--border-s)', boxShadow: 'var(--shadow)' }}>
              <div style={{ fontSize: 13, color: 'var(--ink-700)', whiteSpace: 'nowrap' }}>
                <span style={{ fontWeight: 600, color: 'var(--ink-900)' }}>{selected.size} selected</span> ·{' '}
                <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' }}>{formatNative(selectedTotal.toString())} {asset}</span>
              </div>
              <div style={{ width: 1, height: 22, background: 'var(--border)' }} />
              <Button size="sm" onClick={() => onSendSelected([...selected])}>
                <SendIcon size={16} />
                Send selected
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void freezeSelected()}>
                <SnowIcon size={16} />
                Freeze
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          </div>
        )}
      </div>
    </Screen>
  )
}

function StatCard({ label, value, unit = false, minWidth, tone, icon }: { label: string; value: string; unit?: boolean; minWidth: number; tone?: 'frozen'; icon?: ReactNode }) {
  const valueColor = tone === 'frozen' ? 'var(--frozen)' : 'var(--ink-900)'
  const asset = useAssetLabel()
  return (
    <div style={{ flex: 1, minWidth, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '15px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink-500)', fontWeight: 500 }}>
        {tone === 'frozen' && <span style={{ display: 'flex', color: 'var(--frozen)' }}>{icon}</span>}
        {label}
      </div>
      <div style={{ fontSize: 21, fontWeight: 600, fontFamily: 'var(--display-font)', fontVariantNumeric: 'tabular-nums', color: valueColor, marginTop: 5 }}>
        {value}
        {unit && <span style={{ fontSize: 13, color: 'var(--ink-500)', fontWeight: 600 }}> {asset}</span>}
      </div>
    </div>
  )
}

function CoinRow({
  coin,
  tokenAsset,
  selected,
  onToggleSelect,
  onLabel,
  onToggleFreeze,
}: {
  coin: UtxoView
  tokenAsset?: TokenAsset
  selected: boolean
  onToggleSelect: () => void
  onLabel: (label: string) => void
  onToggleFreeze: () => void
}) {
  const [editing, setEditing] = useState(false)
  const asset = useAssetLabel()
  const pq = coin.algo === 'falcon512'
  const primary = coin.label ?? coin.address
  // Token UTXOs aren't selectable for coin-control (which builds a native send); they
  // can still be labelled and frozen.
  const selectable = !coin.frozen && tokenAsset === undefined
  return (
    <div className="coin-row" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 16px', borderTop: '1px solid var(--border)', boxShadow: `inset 3px 0 0 ${coin.frozen ? 'var(--frozen)' : 'transparent'}` }}>
      <button
        type="button"
        onClick={onToggleSelect}
        disabled={!selectable}
        aria-label="Select coin"
        aria-pressed={selected}
        title={tokenAsset !== undefined ? 'Tokens are sent from the Tokens panel, not coin control' : coin.frozen ? 'Frozen — unfreeze to select' : undefined}
        style={{ flex: 'none', width: 20, height: 20, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: selectable ? 'pointer' : 'not-allowed', color: '#fff', border: selected ? 'none' : '1.5px solid var(--border-s)', background: selected ? 'var(--primary)' : 'transparent', opacity: selectable ? 1 : 0.4 }}
      >
        {selected && <CheckIcon size={13} />}
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            autoFocus
            defaultValue={coin.label ?? ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            onBlur={(e) => {
              onLabel(e.currentTarget.value)
              setEditing(false)
            }}
            placeholder="Add label"
            aria-label="Coin label"
            style={{ width: '100%', maxWidth: 280, height: 28, padding: '0 8px', borderRadius: 7, border: '1px solid var(--primary)', background: 'var(--card-el)', color: 'var(--ink-900)', fontSize: 13, outline: 'none' }}
          />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }}>{primary}</span>
              <button type="button" className="coin-pencil" onClick={() => setEditing(true)} title="Edit label" aria-label="Edit label" style={{ flex: 'none', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer', color: 'var(--ink-500)' }}>
                <PencilIcon size={13} />
              </button>
              {coin.frozen && (
                <Pill tone="frozen" icon={<SnowIcon size={13} />}>
                  Frozen
                </Pill>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3 }}>
              <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: coin.frozen ? 'var(--ink-300)' : 'var(--ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{coin.address}</span>
              {pq && <Pill tone="pq">PQ</Pill>}
            </div>
          </>
        )}
      </div>

      <div style={{ textAlign: 'right', flex: 'none' }}>
        <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)' }}>
          {tokenAsset !== undefined ? `${formatToken(coin.tokenAmountAtomic ?? '0', tokenAsset.decimals)} ${tokenAsset.ticker}` : `${formatNative(coin.valueAtomic)} ${asset}`}
        </div>
        <div style={{ fontSize: 11.5, marginTop: 2, color: coin.confirmations > 0 ? 'var(--ink-500)' : 'var(--warning)' }}>{coin.confirmations > 0 ? `${String(coin.confirmations)} conf` : 'Pending'}</div>
      </div>

      <button
        type="button"
        onClick={onToggleFreeze}
        title={coin.frozen ? 'Unfreeze' : 'Freeze'}
        aria-label={coin.frozen ? 'Unfreeze coin' : 'Freeze coin'}
        style={{ flex: 'none', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, cursor: 'pointer', border: coin.frozen ? '1px solid transparent' : '1px solid var(--border)', background: coin.frozen ? 'var(--frozen-soft)' : 'transparent', color: coin.frozen ? 'var(--frozen)' : 'var(--ink-500)' }}
      >
        <SnowIcon size={16} />
      </button>
    </div>
  )
}
