import { useState } from 'react'
import type { HistoryItem, TokenBalance } from '../../shared/protocol'
import { brand } from '../brand'
import { TxDetailDrawer } from '../components/TxDetailDrawer'
import { TxLabelLine } from '../components/TxLabelLine'
import { formatNative, formatToken, historyAmount, shortHash } from '../lib/format'
import { useHistory, useSummary, useTokens } from '../lib/walletData'
import { AtomIcon, Button, ChevRightIcon, ReceiveIcon, Screen, SendIcon, TokenGlyph } from '../ui'

// Unlocked dashboard: a balance hero + quick actions + recent activity, matching
// the design's exact spec. Reads come from the shared wallet-data cache (served
// instantly on revisit, refreshed in the background); it holds no keys.
export function WalletHome({ onSend, onReceive, onSeeAll, onSendToken }: { onSend: () => void; onReceive: () => void; onSeeAll: () => void; onSendToken: (token: TokenBalance) => void }) {
  const { data: summary, loading } = useSummary()
  const { data: historyData, error } = useHistory()
  const history = historyData?.items
  const { data: tokens } = useTokens()
  const [openTx, setOpenTx] = useState<HistoryItem | null>(null)

  return (
    <Screen>
      <div style={{ padding: '28px 32px 44px' }}>
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap' }}>
          {/* Main column: balance hero + recent activity */}
          <div style={{ flex: '1 1 0', minWidth: 380, width: '100%' }}>
            <div style={{ background: 'radial-gradient(135% 150% at 0% 0%, color-mix(in srgb, var(--primary) 20%, var(--card)) 0%, var(--card) 52%)', border: '1px solid var(--border)', borderRadius: 18, padding: '26px 28px 24px' }}>
              <div style={{ fontSize: 13, color: 'var(--ink-500)', fontWeight: 500 }}>Total balance</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                {summary !== undefined ? (
                  <>
                    <span style={{ fontFamily: 'var(--display-font)', fontSize: 42, fontWeight: 600, letterSpacing: '-0.025em', color: 'var(--ink-900)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                      {formatNative(summary.balanceAtomic)}
                    </span>
                    <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--ink-500)' }}>{brand.assetLabel}</span>
                  </>
                ) : (
                  <span style={{ fontSize: 42, fontWeight: 600, color: 'var(--ink-500)', lineHeight: 1 }}>{loading ? '…' : '—'}</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
                <Button onClick={onSend}>
                  <SendIcon size={16} />
                  Send
                </Button>
                <Button variant="secondary" onClick={onReceive}>
                  <ReceiveIcon size={16} />
                  Receive
                </Button>
              </div>
            </div>

            {error !== undefined && (
              <div className="field-hint field-hint--error" style={{ marginTop: 14 }}>
                {error.message}
              </div>
            )}

            {/* Recent activity */}
            <div style={{ marginTop: 20, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '15px 18px 13px' }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink-900)' }}>Recent activity</span>
                <button type="button" onClick={onSeeAll} style={{ border: 'none', background: 'transparent', color: 'var(--primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '2px 4px' }}>
                  View all
                </button>
              </div>
              {history === undefined && error === undefined && <Note>Loading…</Note>}
              {history !== undefined && history.length === 0 && <Note>No transactions yet.</Note>}
              {history?.slice(0, 6).map((tx) => (
                <ActivityRow key={tx.txid} tx={tx} onOpen={() => setOpenTx(tx)} />
              ))}
            </div>
          </div>

          {/* Aside: tokens + post-quantum card (wraps below on narrow widths) */}
          <div style={{ width: 320, flex: 'none', display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Only real tokens — the native coin lives in the hero (decision D1) */}
            {tokens !== undefined && tokens.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
                <div style={{ padding: '15px 18px 13px', fontSize: 13, fontWeight: 600, color: 'var(--ink-900)' }}>Tokens</div>
                {tokens.map((t) => (
                  <TokenRow key={t.id} token={t} onSend={() => onSendToken(t)} />
                ))}
              </div>
            )}

            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span style={{ width: 36, height: 36, flex: 'none', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--pq-soft)', color: 'var(--pq)' }}>
                  <AtomIcon size={20} />
                </span>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>Post-quantum secure</div>
              </div>
              <p style={{ fontSize: 13, color: 'var(--ink-500)', lineHeight: 1.55, margin: '13px 0 0' }}>Your keys are protected by Falcon-512 signatures — safe against future quantum attacks.</p>
              <button type="button" onClick={onReceive} style={{ marginTop: 14, border: 'none', background: 'transparent', color: 'var(--pq)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
                View your Falcon address →
              </button>
            </div>
          </div>
        </div>
      </div>
      {openTx !== null && <TxDetailDrawer tx={openTx} onClose={() => setOpenTx(null)} />}
    </Screen>
  )
}

function Note({ children }: { children: string }) {
  return <div style={{ padding: '0 18px 16px', fontSize: 13, color: 'var(--ink-500)' }}>{children}</div>
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
          sub={
            <div style={{ fontSize: 12, color: 'var(--ink-500)', fontFamily: 'var(--mono)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {shortHash(tx.txid)}
              {tx.confirmed ? '' : ' · pending'}
            </div>
          }
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
      </div>
    </div>
  )
}

function TokenRow({ token, onSend }: { token: TokenBalance; onSend: () => void }) {
  const sym = token.symbol ?? token.name ?? 'Token'
  return (
    <button type="button" className="tokrow" onClick={onSend} title={`Send ${sym}`}>
      <TokenGlyph token={token} size={34} />
      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{token.name ?? token.symbol ?? 'Token'}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 1, fontFamily: token.symbol !== undefined ? undefined : 'var(--mono)' }}>{token.symbol ?? shortHash(token.id)}</div>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)' }}>{formatToken(token.amountAtomic, token.decimals)}</div>
      <span className="tokrow-go" aria-hidden="true">
        <ChevRightIcon size={16} />
      </span>
    </button>
  )
}
