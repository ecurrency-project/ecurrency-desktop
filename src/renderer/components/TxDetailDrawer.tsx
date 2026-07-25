import { useEffect, useMemo, useState } from 'react'
import type { AddressAlgo, HistoryItem, TxDetail, TxIoEntry } from '../../shared/protocol'
import { brand } from '../brand'
import { formatNative, formatToken, historyAmount, shortHash, tokenLabels } from '../lib/format'
import { useAdvancedMode } from '../lib/prefs'
import { disassembleScript } from '../lib/script'
import { loadTxDetail, loadTxRaw, saveTxLabel, useBuildNetwork, useTokens } from '../lib/walletData'
import { ChevDownIcon, CloseIcon, CopyIcon, ExternalIcon, PencilIcon } from '../ui'

// Block explorer the "Explorer" button opens (brand-configured; hidden when the
// brand has no public explorer). main routes window.open to the OS browser.
const EXPLORER_TX = brand.explorerTxUrl

// Slide-in panel with the full detail of one transaction: amount, status, an editable
// label, the resolved inputs/outputs (our addresses and post-quantum ones tagged), a
// totals/size/txid summary, and copy/explorer actions. The headline comes from the
// HistoryItem it was opened with; the on-chain detail is fetched on open.
export function TxDetailDrawer({ tx, onClose }: { tx: HistoryItem; onClose: () => void }) {
  const [detail, setDetail] = useState<TxDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const advanced = useAdvancedMode()
  // For labelling upgrade-coinbase provenance with the right source ticker.
  const buildNet = useBuildNetwork()
  const { data: tokensData } = useTokens()
  const tokenById = useMemo(() => new Map((tokensData ?? []).map((t) => [t.id, t] as const)), [tokensData])

  useEffect(() => {
    let active = true
    setDetail(null)
    setError(null)
    void loadTxDetail(tx.txid)
      .then((d) => {
        if (active) setDetail(d)
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      active = false
    }
  }, [tx.txid])

  // Esc closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const incoming = tx.direction === 'in'
  const amountColor = incoming ? 'var(--success)' : 'var(--ink-900)'
  const ioText = (e: TxIoEntry): string => {
    if (e.tokenId !== undefined) {
      const t = tokenById.get(e.tokenId)
      return `${formatToken(e.tokenAmountAtomic ?? '0', t?.decimals ?? 6)} ${t !== undefined ? tokenLabels(t).ticker : 'Token'}`
    }
    return `${formatNative(e.amountAtomic)} ${brand.assetLabel}`
  }

  function copyTxid(): void {
    void navigator.clipboard.writeText(tx.txid)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(8, 8, 6, 0.5)', display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Transaction detail"
        style={{ width: 420, maxWidth: '92%', height: '100%', background: 'var(--bg)', borderLeft: '1px solid var(--border-s)', boxShadow: '-24px 0 60px -24px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', animation: 'qslide .2s ease' }}
      >
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>Transaction</div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close" className="content-refresh" style={{ width: 30, height: 30, padding: 0, justifyContent: 'center', border: 'none' }}>
            <CloseIcon size={18} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 18px 26px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Headline */}
          <div>
            <div style={{ fontSize: 13, color: 'var(--ink-500)', fontWeight: 500 }}>{incoming ? 'Received' : 'Sent'}</div>
            <div style={{ fontSize: 30, fontWeight: 600, fontFamily: 'var(--display-font)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', color: amountColor, marginTop: 4 }}>
              {incoming ? '+' : '−'}
              {historyAmount(tx)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: tx.confirmed ? 'var(--success)' : 'var(--warning)' }} />
              <span style={{ fontSize: 12.5, color: tx.confirmed ? 'var(--ink-500)' : 'var(--warning)', fontWeight: 500 }}>{confText(tx, detail)}</span>
              {tx.blockTime !== undefined && (
                <>
                  <span style={{ color: 'var(--ink-300)' }}>·</span>
                  <span style={{ fontSize: 12.5, color: 'var(--ink-500)' }}>{new Date(tx.blockTime * 1000).toLocaleString()}</span>
                </>
              )}
            </div>
          </div>

          {/* Label */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-500)', marginBottom: 7 }}>Label</div>
            {editing ? (
              <input
                autoFocus
                defaultValue={tx.label ?? ''}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                onBlur={(e) => {
                  setEditing(false)
                  saveTxLabel(tx.txid, e.currentTarget.value)
                }}
                placeholder="Add a label"
                aria-label="Transaction label"
                style={{ width: '100%', height: 40, padding: '0 12px', borderRadius: 10, border: '1px solid var(--primary)', background: 'var(--well)', color: 'var(--ink-900)', fontSize: 14, fontFamily: 'inherit', outline: 'none' }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 40, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--well)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
              >
                <span style={{ flex: 1, fontSize: 14, color: tx.label !== undefined ? 'var(--ink-900)' : 'var(--ink-500)' }}>{tx.label ?? 'Add a label'}</span>
                <span style={{ display: 'flex', color: 'var(--ink-500)' }}>
                  <PencilIcon size={14} />
                </span>
              </button>
            )}
          </div>

          {/* Flow: inputs / outputs */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-500)', marginBottom: 10 }}>Flow</div>
            {error !== null ? (
              <div className="field-hint field-hint--error">{error}</div>
            ) : detail === null ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
                <span className="spinner" aria-label="Loading" />
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <FlowChip label="Total in" value={`${formatNative(detail.totalInAtomic)} ${brand.assetLabel}`} />
                  <FlowChip label="Total out" value={`${formatNative(detail.totalOutAtomic)} ${brand.assetLabel}`} />
                  <FlowChip label="Fee" value={`${formatNative(detail.feeAtomic)} ${brand.assetLabel}`} />
                </div>
                <IoList title="Inputs" entries={detail.inputs} sumAtomic={detail.totalInAtomic} incoming={incoming} ioText={ioText} kind="in" advanced={advanced} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 2px' }}>
                  <span style={{ height: 1, flex: 1, background: 'var(--border)' }} />
                  <span style={{ fontSize: 11, color: 'var(--ink-500)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>fee {formatNative(detail.feeAtomic)} {brand.assetLabel}</span>
                  <span style={{ height: 1, flex: 1, background: 'var(--border)' }} />
                </div>
                <IoList title="Outputs" entries={detail.outputs} sumAtomic={detail.totalOutAtomic} incoming={incoming} ioText={ioText} kind="out" advanced={advanced} />
              </>
            )}
          </div>

          {/* Summary */}
          {detail !== null && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <SummaryRow label="Total in" value={`${formatNative(detail.totalInAtomic)} ${brand.assetLabel}`} first />
              <SummaryRow label="Total out" value={`${formatNative(detail.totalOutAtomic)} ${brand.assetLabel}`} />
              <SummaryRow label="Fee" value={`${formatNative(detail.feeAtomic)} ${brand.assetLabel}`} />
              <SummaryRow label="Size" value={`${String(detail.sizeBytes)} bytes`} />
              <SummaryRow label="Txid" value={shortHash(tx.txid)} mono />
            </div>
          )}

          {/* Upgrade-coinbase provenance: where this credit came from. The fee
              row above IS the protocol fee for such credits (locked − credited). */}
          {detail?.coinbaseInfo !== undefined && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <SummaryRow
                label="Converted from"
                value={`${brand.upgrade?.sourceCoinLabel[buildNet ?? 'mainnet'] ?? 'BTC'} tx ${shortHash(detail.coinbaseInfo.btcTxid)}`}
                mono
                first
              />
              <SummaryRow
                label="Source output"
                value={`block #${String(detail.coinbaseInfo.btcBlockHeight)} · output ${String(detail.coinbaseInfo.btcOutNum)}`}
              />
              <SummaryRow
                label="Locked value"
                value={`${formatNative(detail.coinbaseInfo.valueSat)} ${brand.upgrade?.sourceCoinLabel[buildNet ?? 'mainnet'] ?? 'BTC'}`}
              />
            </div>
          )}

          {/* Advanced: header/technical detail (advanced mode only) */}
          {advanced && detail !== null && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-500)', marginBottom: 7 }}>Details</div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <SummaryRow label="Type" value={txTypeLabel(detail.txType)} first />
                {detail.isCoinbase === true && <SummaryRow label="Coinbase" value="Yes" />}
                {detail.blockHeight !== undefined && <SummaryRow label="Block height" value={String(detail.blockHeight)} />}
                {detail.blockPos !== undefined && <SummaryRow label="Block position" value={String(detail.blockPos)} />}
                {detail.blockHash !== undefined && <SummaryRow label="Block hash" value={shortHash(detail.blockHash)} mono />}
              </div>
            </div>
          )}

          {/* Advanced: raw serialized transaction (fetched lazily on expand) */}
          {advanced && detail !== null && <RawHexSection txid={tx.txid} />}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={copyTxid} className="content-refresh" style={{ flex: 1, justifyContent: 'center', height: 42 }}>
              <CopyIcon size={16} />
              {copied ? 'Copied' : 'Copy txid'}
            </button>
            {EXPLORER_TX !== null && (
              <button type="button" onClick={() => window.open(EXPLORER_TX + tx.txid, '_blank', 'noopener')} className="content-refresh" style={{ flex: 1, justifyContent: 'center', height: 42 }}>
                <ExternalIcon size={16} />
                Explorer
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Confirmation status text: "Pending" while unconfirmed, otherwise the count once the
// detail (which carries the tip-relative count) has loaded.
function confText(tx: HistoryItem, detail: TxDetail | null): string {
  if (!tx.confirmed) return 'Pending'
  if (detail === null) return 'Confirmed'
  return detail.confirmations === 1 ? '1 confirmation' : `${String(detail.confirmations)} confirmations`
}

function IoList({
  title,
  entries,
  sumAtomic,
  incoming,
  ioText,
  kind,
  advanced,
}: {
  title: string
  entries: readonly TxIoEntry[]
  sumAtomic: string
  incoming: boolean
  ioText: (e: TxIoEntry) => string
  kind: 'in' | 'out'
  advanced: boolean
}) {
  // Long input/output lists (some transactions consolidate dozens of UTXOs) collapse to
  // the first few, with a toggle to reveal the rest — so the drawer stays scannable.
  const COLLAPSE_AT = 5
  const [expanded, setExpanded] = useState(false)
  const shown = entries.length > COLLAPSE_AT && !expanded ? entries.slice(0, COLLAPSE_AT) : entries
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--well)' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-700)' }}>
          {title} ({entries.length})
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)' }}>{formatNative(sumAtomic)} {brand.assetLabel}</span>
      </div>
      {shown.map((e, i) => (
        <div key={`${e.address ?? 'na'}:${String(i)}`} style={{ borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: advanced ? '9px 14px 5px' : '9px 14px' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)', flex: 'none' }}>{ioText(e)}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--ink-500)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.address ?? '—'}</span>
            {e.own && <Badge text="YOU" color="var(--primary)" bg="var(--red-soft)" />}
            {e.pq && <Badge text="PQ" color="var(--pq)" bg="var(--pq-soft)" />}
            {kind === 'out' && <OutTag own={e.own} incoming={incoming} />}
          </div>
          {advanced && <IoAdvanced e={e} kind={kind} />}
        </div>
      ))}
      {entries.length > COLLAPSE_AT && (
        <button
          type="button"
          onClick={() => setExpanded((o) => !o)}
          aria-expanded={expanded}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--primary)' }}
        >
          {expanded ? 'Show less' : `Show all ${String(entries.length)}`}
          <span style={{ display: 'flex', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s ease' }}>
            <ChevDownIcon size={14} />
          </span>
        </button>
      )}
    </div>
  )
}

// An output's role from our point of view: our change on a send, the amount we
// received on an incoming tx, or a payment out to someone else.
function OutTag({ own, incoming }: { own: boolean; incoming: boolean }) {
  if (own) {
    return incoming ? <Badge text="received" color="var(--success)" bg="color-mix(in srgb, var(--success) 15%, transparent)" /> : <Badge text="change" color="var(--ink-500)" bg="var(--well)" />
  }
  return <Badge text="sent" color="var(--ink-700)" bg="var(--well)" />
}

function FlowChip({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 9, background: 'var(--well)' }}>
      <div style={{ fontSize: 11, color: 'var(--ink-500)' }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  )
}

function Badge({ text, color, bg }: { text: string; color: string; bg: string }) {
  return <span style={{ flex: 'none', fontSize: 11, fontWeight: 700, color, background: bg, padding: '2px 6px', borderRadius: 999 }}>{text}</span>
}

function SummaryRow({ label, value, mono = false, first = false }: { label: string; value: string; mono?: boolean; first?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '11px 14px', borderTop: first ? undefined : '1px solid var(--border)' }}>
      <span style={{ fontSize: 12.5, color: 'var(--ink-500)', flex: 'none' }}>{label}</span>
      <span style={{ fontSize: mono ? 11.5 : 12.5, fontWeight: 600, fontFamily: 'var(--mono)', color: mono ? 'var(--ink-700)' : 'var(--ink-900)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}

// Per-input/output technical detail, shown under each row in advanced mode: the
// outpoint an input spends, its signature scheme, the scripthash, and the redeem
// script (ASM with a hex toggle). Outputs show just their scripthash.
function IoAdvanced({ e, kind }: { e: TxIoEntry; kind: 'in' | 'out' }) {
  const rows: { k: string; v: string }[] = []
  if (kind === 'in' && e.prevoutTxid !== undefined) rows.push({ k: 'outpoint', v: `${shortHash(e.prevoutTxid)}:${String(e.prevoutVout ?? 0)}` })
  if (kind === 'in' && e.sigScheme !== undefined) rows.push({ k: 'signature', v: schemeLabel(e.sigScheme) })
  if (e.scripthash !== undefined) rows.push({ k: 'scripthash', v: shortHash(e.scripthash) })
  const script = kind === 'in' ? e.redeemScript : undefined
  if (rows.length === 0 && script === undefined) return null
  return (
    <div style={{ padding: '0 14px 9px', display: 'flex', flexDirection: 'column', gap: 3 }}>
      {rows.map((r) => (
        <div key={r.k} style={{ display: 'flex', gap: 8, fontSize: 10.5, fontFamily: 'var(--mono)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--ink-300)', flex: 'none', width: 74 }}>{r.k}</span>
          <span style={{ color: 'var(--ink-500)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.v}</span>
        </div>
      ))}
      {script !== undefined && <ScriptBlock hex={script} />}
    </div>
  )
}

// A redeem script as ASM, with a toggle to flip to the raw hex.
function ScriptBlock({ hex }: { hex: string }) {
  const [showHex, setShowHex] = useState(false)
  const asm = useMemo(() => disassembleScript(hex), [hex])
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, fontFamily: 'var(--mono)', lineHeight: 1.5 }}>
        <span style={{ color: 'var(--ink-300)', flex: 'none', width: 74 }}>redeem</span>
        <button
          type="button"
          onClick={() => setShowHex((o) => !o)}
          style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600, color: 'var(--primary)' }}
        >
          {showHex ? 'show asm' : 'show hex'}
        </button>
      </div>
      <pre style={{ margin: '3px 0 0', padding: '6px 8px', background: 'var(--well)', borderRadius: 6, fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-700)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{showHex ? hex : asm}</pre>
    </div>
  )
}

// Collapsible raw serialized transaction (hex). Fetched lazily the first time it's
// expanded — a separate round-trip we don't pay for unless the user asks.
function RawHexSection({ txid }: { txid: string }) {
  const [open, setOpen] = useState(false)
  const [hex, setHex] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function toggle(): void {
    const next = !open
    setOpen(next)
    if (next && hex === null && error === null) {
      void loadTxRaw(txid)
        .then(setHex)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    }
  }

  function copy(): void {
    if (hex === null) return
    void navigator.clipboard.writeText(hex)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 14px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <span style={{ flex: 1, textAlign: 'left', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-900)' }}>Raw transaction</span>
        <span style={{ display: 'flex', color: 'var(--ink-500)', transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s ease' }}>
          <ChevDownIcon size={16} />
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {error !== null ? (
            <div className="field-hint field-hint--error" style={{ padding: '12px 14px' }}>{error}</div>
          ) : hex === null ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '18px 0' }}>
              <span className="spinner" aria-label="Loading" />
            </div>
          ) : (
            <>
              <pre style={{ margin: 0, padding: '10px 12px', maxHeight: 180, overflow: 'auto', fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-700)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{hex}</pre>
              <button
                type="button"
                onClick={copy}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '9px 14px', borderTop: '1px solid var(--border)', background: 'var(--well)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--primary)' }}
              >
                <CopyIcon size={14} />
                {copied ? 'Copied' : 'Copy hex'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// tx_type id → human label (1 standard, 2 stake, 3 coinbase, 4 tokens).
function txTypeLabel(t?: number): string {
  switch (t) {
    case 1:
      return 'Standard'
    case 2:
      return 'Stake'
    case 3:
      return 'Coinbase'
    case 4:
      return 'Tokens'
    default:
      return t === undefined ? '—' : `Type ${String(t)}`
  }
}

function schemeLabel(s: AddressAlgo | 'unknown'): string {
  return s === 'ecdsa' ? 'ECDSA' : s === 'schnorr' ? 'Schnorr' : s === 'falcon512' ? 'Falcon-512' : 'Unknown'
}
