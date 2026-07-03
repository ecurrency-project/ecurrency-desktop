import { useState, type ReactNode } from 'react'
import type { HistoryItem } from '../../shared/protocol'
import { saveTxLabel } from '../lib/walletData'
import { PencilIcon } from '../ui'

// The editable top line of an activity row: the user's transaction label when set,
// otherwise the direction ("Received"/"Sent"), with a pencil to edit it inline. The
// `sub` (txid, counterparty…) renders beneath it, and is hidden while editing — the
// input takes the whole cell, mirroring the coin-control label editor.
//
// The label is local-only (sealed in main, never on-chain). An edit updates the
// shared history cache optimistically and persists through main, reverting (via a
// cache invalidation) if the write fails. onClick/onKeyDown are stopped from
// bubbling so editing inside a clickable row doesn't also trigger the row.
export function TxLabelLine({ tx, sub }: { tx: HistoryItem; sub: ReactNode }) {
  const [editing, setEditing] = useState(false)
  const fallback = tx.direction === 'in' ? 'Received' : 'Sent'

  function save(value: string): void {
    setEditing(false)
    saveTxLabel(tx.txid, value)
  }

  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={tx.label ?? ''}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        onBlur={(e) => save(e.currentTarget.value)}
        placeholder="Add label"
        aria-label="Transaction label"
        style={{ width: '100%', maxWidth: 280, height: 28, padding: '0 8px', borderRadius: 7, border: '1px solid var(--primary)', background: 'var(--well)', color: 'var(--ink-900)', fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
      />
    )
  }
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tx.label ?? fallback}</span>
        <button
          type="button"
          className="coin-pencil"
          onClick={(e) => {
            e.stopPropagation()
            setEditing(true)
          }}
          title="Edit label"
          aria-label="Edit label"
          style={{ flex: 'none', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer', color: 'var(--ink-500)' }}
        >
          <PencilIcon size={13} />
        </button>
      </div>
      {sub}
    </>
  )
}
