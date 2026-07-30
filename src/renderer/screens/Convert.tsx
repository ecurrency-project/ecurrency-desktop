import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { UpgradePlanView, UpgradeStatusView } from '../../shared/protocol'
import { brand } from '../brand'
import { formatToken } from '../lib/format'
import { wallet } from '../lib/wallet'
import { assetLabelFor } from '../brand/labels'
import { useAddressPlaceholder, useBuildNetwork } from '../lib/walletData'
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
  // Everything below labels the source coin per the BUILD's network (tBTC
  // on testnet) so test coins are never presented as the real thing.
  const buildNet = useBuildNetwork()
  const src = up?.sourceCoinLabel[buildNet ?? 'mainnet'] ?? 'BTC'
  const nativeLabel = assetLabelFor(buildNet)
  const addressHint = useAddressPlaceholder()
  const [status, setStatus] = useState<UpgradeStatusView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // BTC-side sync state of the node: synced flag + headers/scanned heights.
  // null = unknown / not reported (old node, unreachable).
  const [btcSync, setBtcSync] = useState<{ synced?: boolean; headers?: number; scanned?: number } | null>(null)
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
    // The node ignores upgrade transactions until its BTC chain is synced,
    // and credits require the payment's block to be fully SCANNED (which can
    // trail the headers) — surface both so a wait isn't mistaken for a loss.
    wallet
      .nodeStatus()
      .then((n) =>
        setBtcSync(
          n.reachable
            ? {
                ...(n.btcSynced !== undefined ? { synced: n.btcSynced } : {}),
                ...(n.btcHeaders !== undefined ? { headers: n.btcHeaders } : {}),
                ...(n.btcScanned !== undefined ? { scanned: n.btcScanned } : {}),
              }
            : null,
        ),
      )
      .catch(() => setBtcSync(null))
  }, [])

  // Load status + prefill the destination with the wallet's own receive
  // address (classical ECDSA — the default receive type; PQ stays a
  // deliberate choice via Receive → Falcon-512).
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 30_000)
    wallet
      .getReceiveAddress()
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
  const explorerTxBase = buildNet !== null ? (up?.sourceExplorerTxUrl?.[buildNet] ?? null) : null

  // Consensus minimum, for the form hint and a pre-review gate.
  const [minSat, setMinSat] = useState<string | null>(null)
  useEffect(() => {
    wallet
      .upgradeInfo()
      .then((i) => setMinSat(i.minConvertValueSat ?? null))
      .catch(() => {})
  }, [])
  const belowMin = (() => {
    if (convertAll || amount.trim() === '' || minSat === null) return false
    try {
      return BigInt(toSat(amount)) < BigInt(minSat)
    } catch {
      return false // not a number yet — the review gate has its own checks
    }
  })()

  // One hint line UNDER the amount row, so its appearance never moves the row
  // itself: the minimum in manual mode, the fee note in All mode.
  const amountHint = ((): string | null => {
    if (belowMin) return `Below the minimum of ${fromSat(minSat ?? '0')} ${src}.`
    if (convertAll) return hasFunds ? 'The network fee is subtracted from this amount at review.' : null
    return minSat !== null ? `Minimum ${fromSat(minSat)} ${src}` : null
  })()

  // Light client-side shape check for the Return address (main re-validates
  // strictly on submit): legacy base58 or bech32 with the right network prefix.
  const returnAddrLooksValid = useMemo(() => {
    const a = returnAddr.trim()
    if (a === '') return false
    return buildNet === 'testnet'
      ? /^[mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a) || /^tb1[02-9ac-hj-np-z]{8,87}$/i.test(a)
      : /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a) || /^bc1[02-9ac-hj-np-z]{8,87}$/i.test(a)
  }, [returnAddr, buildNet])

  return (
    <Screen center>
      <div style={{ maxWidth: 520, width: '100%', margin: '32px auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loadError !== null && <div className="field-hint field-hint--error">{loadError}</div>}

        {(btcSync?.synced === false || (btcSync?.headers !== undefined && btcSync.scanned !== undefined && btcSync.headers - btcSync.scanned > 2)) && (
          <div
            role="status"
            style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--card)', border: '1px solid var(--warning)', borderRadius: 12, padding: '12px 14px', fontSize: 12.5, color: 'var(--ink-700)', lineHeight: 1.5 }}
          >
            <AlertIcon size={16} />
            <span>
              {btcSync?.synced === false
                ? `The ${nativeLabel} node is still syncing the ${src} chain. You can deposit and convert now, but the network will only credit conversions after that sync completes — expect a delay.`
                : `The ${nativeLabel} node is still scanning ${src} blocks (${String((btcSync?.headers ?? 0) - (btcSync?.scanned ?? 0))} behind). Conversions are credited once the payment's block has been scanned.`}
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
              {/* Same tile treatment as Receive: white field, border all round. */}
              <div style={{ flex: 'none', background: '#fff', padding: 8, borderRadius: 10, border: '1px solid var(--border-s)' }}>
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
            <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>2 · Convert to {nativeLabel}</div>
            <span style={{ fontSize: 13, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-700)' }}>
              {fmtSat(confirmedSat)} {src}
            </span>
            {status !== null && BigInt(status.pendingBalanceSat) > 0n && (
              <span style={{ fontSize: 11.5, color: 'var(--warning)' }}>+{fmtSat(status.pendingBalanceSat)} pending</span>
            )}
          </div>

          {stage === 'form' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              {/* The hint lives BELOW the row, not inside the field: a hint
                  inside would grow the field's column and shift the All button
                  (which aligns to the column's bottom) as the text appears and
                  disappears. */}
              <div>
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
                      state={belowMin ? 'error' : 'default'}
                    />
                  </div>
                  {/* Same height as .field (46px) so the row lines up. */}
                  <Button variant={convertAll ? 'primary' : 'secondary'} style={{ height: 46 }} onClick={() => setConvertAll((v) => !v)}>
                    {convertAll ? 'All ✓' : 'All'}
                  </Button>
                </div>
                {amountHint !== null && (
                  <div className={belowMin ? 'field-hint field-hint--error' : 'field-hint'}>{amountHint}</div>
                )}
              </div>
              <TextField
                label={`Receive to (${brand.assetName} address)`}
                mono
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder={addressHint}
                aria-label="Destination address"
              />
              <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'var(--well)', border: '1px solid var(--border)' }}>
                <span style={{ flex: 'none', color: 'var(--warning)', display: 'flex', marginTop: 1 }}>
                  <AlertIcon size={15} />
                </span>
                <span style={{ fontSize: 12, color: 'var(--ink-700)', lineHeight: 1.55 }}>
                  Conversion is one-way and cannot be undone. The {nativeLabel} amount follows the protocol rate at
                  credit time (≈1% protocol fee applies) and arrives after ~3–4 hours.
                </span>
              </div>
              {error !== null && <div className="field-hint field-hint--error">{error}</div>}
              <Button size="cta" disabled={busy || !hasFunds || dest.trim() === '' || (!convertAll && amount.trim() === '') || belowMin} onClick={() => void review()}>
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
                {nativeLabel} will appear on your address after the {src} transaction has 6 confirmations plus a
                ~2 hour protocol delay (typically ~3 hours in total). Track it below. The deposit address in step 1 is
                already up to date for your next conversion.
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
                  {e.confirmed
                    ? e.confirmations !== undefined && e.confirmations < 6
                      ? `${String(e.confirmations)}/6 confirmations`
                      : `confirmed · crediting ≤2h`
                    : 'pending'}
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
                <TextField
                  label={`Return all ${src} to`}
                  mono
                  value={returnAddr}
                  onChange={(e) => setReturnAddr(e.target.value)}
                  placeholder={`${src} address`}
                  aria-label="Return address"
                  state={returnAddr.trim() !== '' && !returnAddrLooksValid ? 'error' : 'default'}
                  hint={returnAddr.trim() !== '' && !returnAddrLooksValid ? `That does not look like a ${buildNet ?? 'mainnet'} ${src} address.` : undefined}
                />
              </div>
              <Button variant="secondary" style={{ height: 38 }} disabled={busy || !returnAddrLooksValid} onClick={() => void doReturn()}>
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
