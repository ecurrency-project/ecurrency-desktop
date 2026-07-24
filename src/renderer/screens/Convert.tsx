import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useState } from 'react'
import type { UpgradePlanView, UpgradeStatusView } from '../../shared/protocol'
import { brand } from '../brand'
import { formatToken } from '../lib/format'
import { wallet } from '../lib/wallet'
import { useBuildNetwork } from '../lib/walletData'
import { AlertIcon, Button, CheckIcon, CopyIcon, Screen, TextField } from '../ui'

// Convert: the source-chain → native upgrade flow (design:
// docs/btc-upgrade-design.md §4.1). Deposit to your own staging address →
// the wallet detects funds → compose (full or partial) → track episodes.
// Mounted only when brand.upgrade is set AND main reports the flow enabled
// (seed wallet + brand consensus params); everything runs in main, this
// screen only renders views.

const SAT_DECIMALS = 8

function fmtSat(sat: string): string {
  return formatToken(sat, SAT_DECIMALS)
}

/** Satoshi string → plain decimal string for an input value (no grouping). */
function fromSat(sat: string): string {
  const n = BigInt(sat)
  const whole = (n / 100_000_000n).toString()
  const frac = (n % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '')
  return frac === '' ? whole : `${whole}.${frac}`
}

type Stage = 'form' | 'review' | 'sending' | 'done'

export function Convert() {
  const up = brand.upgrade
  const src = up?.sourceCoinLabel ?? 'BTC'
  const [status, setStatus] = useState<UpgradeStatusView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // null = unknown / not reported (old node, unreachable); false = still syncing.
  const [btcSynced, setBtcSynced] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)

  // Compose state.
  const [convertAll, setConvertAll] = useState(true)
  const [amount, setAmount] = useState('')
  const [dest, setDest] = useState('')
  const [stage, setStage] = useState<Stage>('form')
  const [plan, setPlan] = useState<UpgradePlanView | null>(null)
  const [txid, setTxid] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Return-BTC state.
  const [returnOpen, setReturnOpen] = useState(false)
  const [returnAddr, setReturnAddr] = useState('')
  const [returnResult, setReturnResult] = useState<string | null>(null)

  const refresh = useCallback(() => {
    wallet
      .upgradeStatus()
      .then((s) => {
        setStatus(s)
        setLoadError(null)
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
    // The node ignores upgrade transactions until its BTC chain is synced —
    // surface that so a deposit/convert isn't mistaken for a lost credit.
    wallet
      .nodeStatus()
      .then((n) => setBtcSynced(n.reachable ? (n.btcSynced ?? null) : null))
      .catch(() => setBtcSynced(null))
  }, [])

  // Load status + prefill the destination with the wallet's own PQ address —
  // the whole point of converting into a post-quantum chain.
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 30_000)
    wallet
      .getReceiveAddress('falcon512')
      .then((a) => setDest((d) => (d === '' ? a : d)))
      .catch(() => {})
    return () => clearInterval(timer)
  }, [refresh])

  const request = convertAll ? ({ mode: 'all' } as const) : ({ mode: 'amount', amountSat: toSat(amount) } as const)

  const review = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setPlan(await wallet.upgradePlan(request))
      setStage('review')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setStage('sending')
    try {
      const res = await wallet.upgradeConvert(request, dest.trim())
      setTxid(res.txid)
      setStage('done')
      refresh()
    } catch (e) {
      setError((e as Error).message)
      setStage('review')
    } finally {
      setBusy(false)
    }
  }

  const doReturn = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await wallet.upgradeReturn(returnAddr.trim())
      setReturnResult(res.txid)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copyAddress = (): void => {
    if (status === null) return
    void navigator.clipboard.writeText(status.stagingAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const confirmedSat = status?.confirmedBalanceSat ?? '0'
  const hasFunds = BigInt(confirmedSat) > 0n

  // Source-chain explorer link for the BUILD's network (a testnet profile
  // must never open a mainnet explorer). Hidden until the network is known.
  const buildNet = useBuildNetwork()
  const explorerTxBase = buildNet !== null ? (up?.sourceExplorerTxUrl?.[buildNet] ?? null) : null

  return (
    <Screen center>
      <div style={{ maxWidth: 520, width: '100%', margin: '32px auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loadError !== null && <div className="field-hint field-hint--error">{loadError}</div>}

        {btcSynced === false && (
          <div
            role="status"
            style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--card)', border: '1px solid var(--warning)', borderRadius: 12, padding: '12px 14px', fontSize: 12.5, color: 'var(--ink-700)', lineHeight: 1.5 }}
          >
            <AlertIcon size={16} />
            <span>
              The {brand.assetLabel} node is still syncing the {src} chain. You can deposit and convert now, but the
              network will only credit conversions after that sync completes — expect a delay.
            </span>
          </div>
        )}

        {/* Deposit */}
        <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>1 · Deposit {src}</div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-500)', marginTop: 4, lineHeight: 1.5 }}>
            Send {src} to your personal staging address below — from any wallet or exchange, as an ordinary payment. The
            address is derived from your recovery phrase; the funds stay yours until you convert.
          </div>
          {status !== null && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 14 }}>
              <div style={{ flex: 'none', background: '#fff', padding: 8, borderRadius: 10 }}>
                <QRCodeSVG value={status.stagingAddress} size={96} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <code style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-900)', wordBreak: 'break-all' }}>{status.stagingAddress}</code>
                <div style={{ marginTop: 8 }}>
                  <Button variant="secondary" size="sm" onClick={copyAddress}>
                    {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                    {copied ? 'Copied' : 'Copy address'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Balance + compose */}
        <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>2 · Convert to {brand.assetLabel}</div>
            <span style={{ fontSize: 13, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-700)' }}>
              {fmtSat(confirmedSat)} {src}
            </span>
            {status !== null && BigInt(status.pendingBalanceSat) > 0n && (
              <span style={{ fontSize: 11.5, color: 'var(--warning)' }}>+{fmtSat(status.pendingBalanceSat)} pending</span>
            )}
          </div>

          {stage === 'form' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <TextField
                    label={`Amount (${src})`}
                    mono
                    // "All" shows the balance it will spend (the network fee is
                    // subtracted at review, where the exact number is known).
                    value={convertAll ? (hasFunds ? fromSat(confirmedSat) : '') : amount}
                    disabled={convertAll}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder={convertAll ? 'Entire balance (minus network fee)' : '0.0'}
                    aria-label={`Amount in ${src}`}
                  />
                </div>
                {/* Same height as .field (46px) so the row lines up. */}
                <Button variant={convertAll ? 'primary' : 'secondary'} style={{ height: 46 }} onClick={() => setConvertAll((v) => !v)}>
                  {convertAll ? 'All ✓' : 'All'}
                </Button>
              </div>
              {convertAll && hasFunds && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-500)', marginTop: -6 }}>
                  The network fee is subtracted from this amount at review.
                </div>
              )}
              <TextField
                label={`Receive to (${brand.assetName} address)`}
                mono
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder={brand.addressPlaceholder}
                aria-label="Destination address"
              />
              <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'var(--well)', border: '1px solid var(--border)' }}>
                <span style={{ flex: 'none', color: 'var(--warning)', display: 'flex', marginTop: 1 }}>
                  <AlertIcon size={15} />
                </span>
                <span style={{ fontSize: 12, color: 'var(--ink-700)', lineHeight: 1.55 }}>
                  Conversion is one-way and cannot be undone. The {brand.assetLabel} amount follows the protocol rate at
                  credit time (≈1% protocol fee applies) and arrives after ~3–4 hours.
                </span>
              </div>
              {error !== null && <div className="field-hint field-hint--error">{error}</div>}
              <Button size="cta" disabled={busy || !hasFunds || dest.trim() === '' || (!convertAll && amount.trim() === '')} onClick={() => void review()}>
                {busy ? 'Preparing…' : hasFunds ? 'Review conversion' : `Waiting for ${src} deposit…`}
              </Button>
            </div>
          )}

          {stage === 'review' && plan !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              <div style={{ background: 'var(--well)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                <Row label="Converting" value={`${fmtSat(plan.sendValueSat)} ${src}`} strong />
                <Row label="Network fee" value={`${fmtSat(plan.feeSat)} ${src}${plan.foldedChange ? ' (includes sub-dust remainder)' : ''}`} />
                {BigInt(plan.changeValueSat) > 0n && <Row label="Stays on staging" value={`${fmtSat(plan.changeValueSat)} ${src} → next address`} />}
                <Row label="Credited to" value={dest.trim()} mono />
              </div>
              {error !== null && <div className="field-hint field-hint--error">{error}</div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <Button variant="secondary" size="cta" style={{ width: 120, flex: 'none' }} disabled={busy} onClick={() => setStage('form')}>
                  Back
                </Button>
                <Button size="cta" style={{ flex: 1 }} disabled={busy} onClick={() => void confirm()}>
                  Convert now
                </Button>
              </div>
            </div>
          )}

          {stage === 'sending' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '28px 0 12px' }}>
              <span className="spinner" />
              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--ink-500)' }}>Signing and broadcasting to the {src} network…</div>
            </div>
          )}

          {stage === 'done' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--success)', fontSize: 14, fontWeight: 600 }}>
                <CheckIcon size={18} /> Conversion transaction sent
              </div>
              <code style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-700)', wordBreak: 'break-all' }}>{txid}</code>
              <div style={{ fontSize: 12.5, color: 'var(--ink-500)', lineHeight: 1.5 }}>
                {brand.assetLabel} will appear on your address after the {src} transaction confirms and the network
                credits it (~3–4 hours). Track it below.
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  setStage('form')
                  setPlan(null)
                  setTxid('')
                }}
              >
                Start another conversion
              </Button>
            </div>
          )}
        </section>

        {/* Episodes */}
        <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>3 · Conversions</div>
          {status === null || status.episodes.length === 0 ? (
            <div style={{ padding: '0 20px 18px', fontSize: 13, color: 'var(--ink-500)' }}>No conversions from this wallet yet.</div>
          ) : (
            status.episodes.map((e) => (
              <div key={e.txid} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderTop: '1px solid var(--border)' }}>
                <span style={{ width: 7, height: 7, flex: 'none', borderRadius: '50%', background: e.confirmed ? 'var(--success)' : 'var(--warning)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)' }}>
                    {fmtSat(e.lockValueSat)} {src}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-500)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.txid}</div>
                </div>
                <span style={{ fontSize: 11.5, color: e.confirmed ? 'var(--ink-500)' : 'var(--warning)', flex: 'none' }}>
                  {e.confirmed ? `confirmed${e.blockHeight !== undefined ? ` · ${String(e.blockHeight)}` : ''}` : 'pending'}
                </span>
                {explorerTxBase !== null && (
                  <button
                    type="button"
                    className="content-refresh"
                    style={{ height: 26, padding: '0 8px', fontSize: 11.5 }}
                    onClick={() => window.open(`${explorerTxBase}${e.txid}`, '_blank', 'noopener')}
                  >
                    Explorer
                  </button>
                )}
              </div>
            ))
          )}
        </section>

        {/* Return */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!returnOpen ? (
            <button
              type="button"
              onClick={() => setReturnOpen(true)}
              style={{ alignSelf: 'flex-start', padding: 0, border: 'none', background: 'transparent', color: 'var(--ink-500)', fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}
            >
              Changed your mind? Return {src} to another address
            </button>
          ) : returnResult !== null ? (
            <div style={{ fontSize: 12.5, color: 'var(--success)' }}>
              Returned — txid <code style={{ fontFamily: 'var(--mono)' }}>{returnResult}</code>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <TextField label={`Return all ${src} to`} mono value={returnAddr} onChange={(e) => setReturnAddr(e.target.value)} placeholder={`${src} address`} aria-label="Return address" />
              </div>
              <Button variant="secondary" style={{ height: 38 }} disabled={busy || returnAddr.trim() === ''} onClick={() => void doReturn()}>
                Return
              </Button>
            </div>
          )}
        </section>
      </div>
    </Screen>
  )
}

function Row({ label, value, mono = false, strong = false }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ flex: 'none', width: 130, color: 'var(--ink-500)' }}>{label}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: 'right',
          color: 'var(--ink-900)',
          fontWeight: strong ? 600 : 500,
          fontFamily: mono ? 'var(--mono)' : undefined,
          wordBreak: mono ? 'break-all' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  )
}

// Parse a decimal source-coin amount (8 decimals) into satoshi as a string.
// Invalid input becomes '0' — the plan call then reports a helpful error.
function toSat(decimal: string): string {
  const s = decimal.trim()
  if (!/^\d+(\.\d{1,8})?$/.test(s)) return '0'
  const [whole, frac = ''] = s.split('.')
  return (BigInt(whole ?? '0') * 100_000_000n + BigInt(frac.padEnd(8, '0'))).toString()
}
