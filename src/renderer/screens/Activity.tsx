import { useEffect, useState } from 'react'
import type { HistoryItem } from '../../shared/protocol'
import { brand } from '../brand'
import { TxDetailDrawer } from '../components/TxDetailDrawer'
import { TxLabelLine } from '../components/TxLabelLine'
import { formatNative, historyAmount, shortHash } from '../lib/format'
import { loadMoreHistory, resetHistoryPages, useHistory } from '../lib/walletData'
import { Button, ReceiveIcon, Screen, SendIcon } from '../ui'

// Full transaction history: the wallet's activity grouped by day, with a
// direction filter. Reads from the shared cache (so it shares data with the
// dashboard's "Recent activity" and stays live via the 30s poll). A row opens the
// transaction detail drawer. Holds no keys.

type Filter = 'all' | 'received' | 'sent' | 'tokens'
const FILTERS: readonly (readonly [Filter, string])[] = [
  ['all', 'All'],
  ['received', 'Received'],
  ['sent', 'Sent'],
  ['tokens', 'Tokens'],
]

function matchesFilter(tx: HistoryItem, f: Filter): boolean {
  switch (f) {
    case 'received':
      return tx.direction === 'in'
    case 'sent':
      return tx.direction === 'out'
    case 'tokens':
      return tx.tokenId !== undefined
    default:
      return true
  }
}

export function Activity() {
  const { data, error } = useHistory()
  const [filter, setFilter] = useState<Filter>('all')
  const [loadingMore, setLoadingMore] = useState(false)
  const [openTx, setOpenTx] = useState<HistoryItem | null>(null)

  // Leaving Activity returns history to a single page, so the dashboard and the
  // background poll don't keep re-fetching the deeper list.
  useEffect(() => () => resetHistoryPages(), [])

  const hasMore = data?.hasMore ?? false
  const items = (data?.items ?? []).filter((tx) => matchesFilter(tx, filter))
  const groups = groupByDate(items)

  return (
    <Screen>
      <div style={{ padding: 40, maxWidth: 720, width: '100%', margin: '0 auto' }}>
        {/* Direction filters */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
          {FILTERS.map(([key, label]) => {
            const active = filter === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                style={{ padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: active ? '1px solid transparent' : '1px solid var(--border-s)', background: active ? 'var(--primary)' : 'transparent', color: active ? '#fff' : 'var(--ink-700)' }}
              >
                {label}
              </button>
            )
          })}
        </div>

        {error !== undefined && (
          <div className="field-hint field-hint--error" style={{ marginBottom: 12 }}>
            {error.message}
          </div>
        )}

        {data === undefined && error === undefined ? (
          <div style={{ padding: '24px 4px', fontSize: 13, color: 'var(--ink-500)' }}>Loading…</div>
        ) : groups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--ink-500)' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-700)' }}>No transactions here</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>Nothing matches this filter yet.</div>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-500)', padding: '0 2px 8px' }}>{group.label}</div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
                {group.items.map((tx) => (
                  <ActivityRow key={tx.txid} tx={tx} onOpen={() => setOpenTx(tx)} />
                ))}
              </div>
            </div>
          ))
        )}

        {hasMore && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
            <Button
              variant="secondary"
              size="sm"
              disabled={loadingMore}
              onClick={() => {
                setLoadingMore(true)
                void loadMoreHistory().finally(() => setLoadingMore(false))
              }}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>
      {openTx !== null && <TxDetailDrawer tx={openTx} onClose={() => setOpenTx(null)} />}
    </Screen>
  )
}

function ActivityRow({ tx, onOpen }: { tx: HistoryItem; onOpen: () => void }) {
  const incoming = tx.direction === 'in'
  return (
    <div
      className="activity-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', borderTop: '1px solid var(--border)', cursor: 'pointer' }}
    >
      <span
        style={{
          width: 38,
          height: 38,
          borderRadius: 11,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: incoming ? 'color-mix(in srgb, var(--success) 15%, transparent)' : 'var(--well)',
          color: incoming ? 'var(--success)' : 'var(--ink-700)',
        }}
      >
        {incoming ? <ReceiveIcon size={18} /> : <SendIcon size={18} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <TxLabelLine
          tx={tx}
          sub={<div style={{ fontSize: 12, color: 'var(--ink-500)', fontFamily: 'var(--mono)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortHash(tx.txid)}</div>}
        />
      </div>
      <div style={{ textAlign: 'right', flex: 'none' }}>
        <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: incoming ? 'var(--success)' : 'var(--ink-900)' }}>
          {incoming ? '+' : '−'}
          {historyAmount(tx)}
        </div>
        {/* A token send's native fee isn't part of the token headline — surface it. */}
        {tx.direction === 'out' && tx.tokenId !== undefined && (
          <div style={{ fontSize: 11, marginTop: 2, color: 'var(--ink-500)', fontFamily: 'var(--mono)' }}>fee {formatNative(tx.feeAtomic)} {brand.assetLabel}</div>
        )}
        <div style={{ fontSize: 11.5, marginTop: 2, color: tx.confirmed ? 'var(--ink-500)' : 'var(--warning)' }}>{rowTime(tx)}</div>
      </div>
    </div>
  )
}

// Bucket transactions (already newest-first) by day, preserving order. Unconfirmed
// ones carry no block time and fall into a "Pending" group, which sorts to the top
// because getHistory lists them first.
function groupByDate(items: readonly HistoryItem[]): { label: string; items: HistoryItem[] }[] {
  const order: string[] = []
  const byLabel = new Map<string, HistoryItem[]>()
  for (const tx of items) {
    const label = dateLabel(tx)
    let bucket = byLabel.get(label)
    if (bucket === undefined) {
      bucket = []
      byLabel.set(label, bucket)
      order.push(label)
    }
    bucket.push(tx)
  }
  return order.map((label) => ({ label, items: byLabel.get(label) as HistoryItem[] }))
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function dateLabel(tx: HistoryItem): string {
  if (!tx.confirmed || tx.blockTime === undefined) return 'Pending'
  const d = new Date(tx.blockTime * 1000)
  const now = new Date()
  if (sameDay(d, now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return 'Yesterday'
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear() ? { month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric', year: 'numeric' }
  return d.toLocaleDateString(undefined, opts)
}

function rowTime(tx: HistoryItem): string {
  if (!tx.confirmed || tx.blockTime === undefined) return 'Pending'
  return new Date(tx.blockTime * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
