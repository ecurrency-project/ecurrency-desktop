import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { SendPreview, TokenBalance, TokenSendPreview } from '../../shared/protocol'
import { brand } from '../brand'
import { formatNative, formatToken, parseNative, parseToken, tokenLabels } from '../lib/format'
import { wallet } from '../lib/wallet'
import { coinSelectionShort, isInsufficientFundsError } from '../lib/sendValidation'
import { invalidate, setContacts as cacheSetContacts, useActiveWallet, useCoins, useContacts, useTokens } from '../lib/walletData'
import { AlertIcon, Button, CheckIcon, ChevDownIcon, ChevRightIcon, CoinsIcon, ContactDialog, ContactIcon, CopyIcon, EyeIcon, Pill, PlusIcon, Screen } from '../ui'

// Send flow: form → review (built + held in main) → sending (sign + broadcast) →
// done / failed. The renderer never builds or signs; it calls window.wallet and
// shows the preview. Amounts go to main as atomic strings (integer math).
type Stage = 'form' | 'building' | 'review' | 'sending' | 'done' | 'failed'

export function Send({ onDone, preselected = [], token = null }: { onDone: () => void; preselected?: readonly string[]; token?: TokenBalance | null }) {
  const [stage, setStage] = useState<Stage>('form')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [preview, setPreview] = useState<SendPreview | null>(null)
  const [tokenPreview, setTokenPreview] = useState<TokenSendPreview | null>(null)
  const [txid, setTxid] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The asset being sent: null = native coin, otherwise a token. The entry point
  // pre-selects it (hero → native coin, Tokens panel → that token); it's switchable here.
  const [asset, setAsset] = useState<TokenBalance | null>(token)
  const [assetMenuOpen, setAssetMenuOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [formFee, setFormFee] = useState<string | null>(null)
  const [feeLoading, setFeeLoading] = useState(false)
  const [feeBlocked, setFeeBlocked] = useState(false)
  // Native send can't be funded: the live draft build refused with
  // InsufficientFundsError (pool or manual selection can't cover amount + fee).
  const [feeShort, setFeeShort] = useState(false)
  const [maxMode, setMaxMode] = useState(false)
  const [maxLoading, setMaxLoading] = useState(false)
  // Coin control: which UTXOs to spend (seeded from a Coins-screen handoff). Empty =
  // automatic selection. native-coin only; token sends pick their own UTXOs.
  const [selectedCoins, setSelectedCoins] = useState<ReadonlySet<string>>(() => new Set(preselected))
  const [coinOpen, setCoinOpen] = useState(preselected.length > 0)
  const { data: contactsData } = useContacts()
  const { data: coinsData } = useCoins()
  const { data: tokensData } = useTokens()
  const activeWallet = useActiveWallet()
  const contacts = contactsData ?? []
  const tokens = tokensData ?? []

  const assetSym = asset !== null ? tokenLabels(asset).ticker : brand.assetLabel
  const decimals = asset !== null ? asset.decimals : 8
  const parseAmount = (s: string): bigint => (asset !== null ? parseToken(s, asset.decimals) : parseNative(s))
  // "Available": for the native coin, the spendable (unfrozen) balance — matching the Coins
  // screen's "Spendable"; for a token, its full balance (the fee is a separate native amount).
  const nativeAvailable = coinsData !== undefined ? coinsData.filter((c) => !c.frozen).reduce((sum, c) => sum + BigInt(c.valueAtomic), 0n).toString() : null
  const availableLabel = asset !== null ? `${formatToken(asset.amountAtomic, decimals)} ${assetSym}` : nativeAvailable !== null ? `${formatNative(nativeAvailable)} ${brand.assetLabel}` : null

  // Switching asset starts a fresh compose — clear the amount, fee and any errors.
  function switchAsset(next: TokenBalance | null): void {
    setAsset(next)
    setAssetMenuOpen(false)
    setAmount('')
    setFormFee(null)
    setFeeBlocked(false)
    setFeeShort(false)
    setMaxMode(false)
    setSelectedCoins(new Set())
    setCoinOpen(false)
    setError(null)
  }

  // Coin-control derivations (native-coin sends only). `outpoints` drives the build:
  // a manual selection spends exactly those; an empty one lets main auto-select.
  const spendableCoins = (coinsData ?? []).filter((c) => c.tokenId === undefined && !c.frozen)
  const outpoints = selectedCoins.size > 0 ? [...selectedCoins] : undefined
  const coinKey = outpoints?.join(',') ?? ''
  const pickedAtomic = spendableCoins.filter((c) => selectedCoins.has(c.outpoint)).reduce((sum, c) => sum + BigInt(c.valueAtomic), 0n)
  let amountParsed: bigint | null = null
  if (asset === null && amount.trim() !== '') {
    try {
      const a = parseNative(amount)
      if (a > 0n) amountParsed = a
    } catch {
      amountParsed = null
    }
  }
  // The full need (amount + fee) is only known once the live draft returned a
  // fee; shown in the coin-control footer. The shortfall decision itself is a
  // pure helper (unit-tested) — see sendValidation.
  const needAtomic = amountParsed !== null && formFee !== null ? amountParsed + BigInt(formFee) : null
  const coinShort = coinSelectionShort({
    selectedCount: selectedCoins.size,
    maxMode,
    picked: pickedAtomic,
    amount: amountParsed,
    fee: formFee !== null ? BigInt(formFee) : null,
    feeShort,
  })
  function toggleCoin(outpoint: string): void {
    setSelectedCoins((prev) => {
      const next = new Set(prev)
      if (next.has(outpoint)) next.delete(outpoint)
      else next.add(outpoint)
      return next
    })
    if (maxMode) setMaxMode(false)
  }

  // Live network-fee estimate for the composed transaction. The fee rate is flat
  // on this chain, but the amount depends on the transaction's size — which varies
  // with the inputs and their signature scheme (a post-quantum input is far larger
  // than a classical one) — so it's obtained by building a draft in main once the
  // recipient and amount settle. Display-only; the authoritative build runs on review.
  useEffect(() => {
    if (stage !== 'form' || maxMode) return
    const r = recipient.trim()
    let atomic: bigint | null = null
    try {
      atomic = parseAmount(amount)
    } catch {
      atomic = null
    }
    if (r === '' || atomic === null || atomic <= 0n) {
      setFormFee(null)
      setFeeLoading(false)
      setFeeBlocked(false)
      setFeeShort(false)
      return
    }
    const value = atomic.toString()
    let active = true
    setFeeLoading(true)
    const handle = setTimeout(() => {
      const build = asset !== null ? wallet.buildTokenSend(asset.id, r, value) : wallet.buildSend(r, value, outpoints)
      void build
        .then((res) => {
          if (active) {
            setFormFee(res.feeAtomic)
            setFeeBlocked(false)
            setFeeShort(false)
          }
        })
        .catch((e: unknown) => {
          if (active) {
            setFormFee(null)
            const msg = e instanceof Error ? e.message : ''
            // Native send the pool / manual selection can't fund — surface it NOW
            // instead of silently showing '—' and failing on Review (predicate is
            // message-based; see sendValidation for why not the error name).
            setFeeShort(asset === null && isInsufficientFundsError(msg))
            // A token send needs a little native balance for the fee; flag that for the warning.
            setFeeBlocked(asset !== null && /network fee/i.test(msg))
          }
        })
        .finally(() => {
          if (active) setFeeLoading(false)
        })
    }, 600)
    return () => {
      active = false
      clearTimeout(handle)
    }
    // coinKey is the content-based dependency for the selected outpoints (the array
    // identity is unstable); depending on it directly would re-run every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipient, amount, coinKey, stage, maxMode, asset])

  const busy = stage === 'building' || stage === 'sending'
  const matched = contacts.find((c) => c.address === recipient.trim()) ?? null

  // Enable send-max for native coin: fills the amount with the whole (selected)
  // pool minus its fee. Shared by the amount-field "Max" button and the
  // "Send maximum" shortcut in the insufficient-funds warning.
  function enableMax(): void {
    if (asset !== null || maxLoading) return
    setMaxLoading(true)
    void wallet
      .maxSendable(outpoints)
      .then((m) => {
        setAmount(formatNative(m.amountAtomic))
        setFormFee(m.feeAtomic)
        setMaxMode(true)
        setError(null)
        setFeeShort(false)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMaxLoading(false))
  }

  async function review(): Promise<void> {
    setError(null)
    // Token transfer: the amount is in the token's units; the fee is native coin.
    if (asset !== null) {
      let atomic: bigint
      try {
        atomic = parseToken(amount, asset.decimals)
      } catch (e) {
        setError((e as Error).message)
        return
      }
      if (atomic <= 0n) {
        setError('Amount must be greater than zero.')
        return
      }
      setStage('building')
      try {
        setTokenPreview(await wallet.buildTokenSend(asset.id, recipient.trim(), atomic.toString()))
        setStage('review')
      } catch (e) {
        setError((e as Error).message)
        setStage('form')
      }
      return
    }
    // Send-max ignores the typed amount — main spends the whole pool to one output.
    if (maxMode) {
      setStage('building')
      try {
        setPreview(await wallet.buildSend(recipient.trim(), '0', outpoints, true))
        setStage('review')
      } catch (e) {
        setError((e as Error).message)
        setStage('form')
      }
      return
    }
    let atomic: bigint
    try {
      atomic = parseNative(amount)
    } catch (e) {
      setError((e as Error).message)
      return
    }
    if (atomic <= 0n) {
      setError('Amount must be greater than zero.')
      return
    }
    setStage('building')
    try {
      setPreview(await wallet.buildSend(recipient.trim(), atomic.toString(), outpoints))
      setStage('review')
    } catch (e) {
      setError((e as Error).message)
      setStage('form')
    }
  }

  async function confirm(): Promise<void> {
    setError(null)
    setStage('sending')
    try {
      const result = await wallet.confirmSend()
      setTxid(result.txid)
      setStage('done')
      // The spend changed balance, history and the UTXO set — refresh those views.
      invalidate('summary', 'history', 'coins')
    } catch (e) {
      setError((e as Error).message)
      setStage('failed')
    }
  }

  function copyTxid(): void {
    void navigator.clipboard.writeText(txid)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // A watch-only wallet has no keys, so there's nothing to sign with — the Send pane
  // explains that instead of showing a form.
  if (activeWallet?.kind === 'watch') {
    return (
      <Screen center>
        <div style={{ maxWidth: 420, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 14, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: 28 }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, flex: 'none', borderRadius: '50%', background: 'var(--watch-soft)', color: 'var(--watch)' }}>
            <EyeIcon size={24} />
          </span>
          <div style={{ fontSize: 18, fontWeight: 600, fontFamily: 'var(--display-font)', color: 'var(--ink-900)' }}>Watch-only wallet</div>
          <div style={{ fontSize: 13.5, color: 'var(--ink-500)', lineHeight: 1.5 }}>
            “{activeWallet.label}” has no keys, so it can’t send. Switch to a wallet that can sign to send {brand.assetLabel} or tokens.
          </div>
        </div>
      </Screen>
    )
  }

  return (
    <Screen center>
      <div style={{ maxWidth: 480, width: '100%', margin: '40px auto' }}>
        {(stage === 'form' || stage === 'building') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: 20 }}>
            {/* Recipient */}
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--ink-700)' }}>Recipient</span>
                <button
                  type="button"
                  onClick={() => setPickerOpen((o) => !o)}
                  aria-expanded={pickerOpen}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0, border: 'none', background: 'transparent', color: 'var(--primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  <ContactIcon size={14} />
                  From contacts
                </button>
              </div>
              <input
                className="field field--mono"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder={`${brand.addressPlaceholder} address or contact`}
                aria-label="Recipient address"
              />
              {/* Click-away layer: a dropdown must close when the user clicks
                  anywhere else, not only on the toggle again. */}
              {pickerOpen && <div role="presentation" onClick={() => setPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 19 }} />}
              {pickerOpen && (
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 20, background: 'var(--card-el)', border: '1px solid var(--border-s)', borderRadius: 12, boxShadow: 'var(--shadow)', padding: 4 }}>
                  {contacts.map((c) => (
                    <button
                      key={c.address}
                      type="button"
                      className="picker-row"
                      onClick={() => {
                        setRecipient(c.address)
                        setPickerOpen(false)
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 11px', border: 'none', background: 'transparent', borderRadius: 8, cursor: 'pointer', textAlign: 'left' }}
                    >
                      <span style={{ width: 30, height: 30, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--red-soft)', color: 'var(--primary)', fontWeight: 700, fontSize: 13 }}>
                        {c.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--ink-900)' }}>{c.name}</span>
                        <span style={{ display: 'block', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.address}</span>
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="picker-row"
                    onClick={() => {
                      setPickerOpen(false)
                      setContactOpen(true)
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 11px', border: 'none', background: 'transparent', borderRadius: 8, cursor: 'pointer', textAlign: 'left', borderTop: contacts.length > 0 ? '1px solid var(--border)' : undefined, marginTop: contacts.length > 0 ? 2 : 0 }}
                  >
                    <span style={{ width: 30, height: 30, flex: 'none', borderRadius: '50%', border: '1px dashed var(--border-s)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}>
                      <PlusIcon size={16} />
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary)' }}>New contact</span>
                  </button>
                </div>
              )}
              {recipient.trim().length > 0 && matched === null && (
                <button
                  type="button"
                  onClick={() => {
                    setPickerOpen(false)
                    setContactOpen(true)
                  }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, padding: '2px 2px', border: 'none', background: 'transparent', color: 'var(--primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  <PlusIcon size={14} />
                  Save as contact
                </button>
              )}
            </div>

            {/* Amount */}
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--ink-700)' }}>Amount</span>
                {availableLabel !== null && <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>Available {availableLabel}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 56, padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--well)' }}>
                <input
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value)
                    if (maxMode) setMaxMode(false)
                  }}
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label={`Amount in ${assetSym}`}
                  style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', color: 'var(--ink-900)', fontSize: 26, fontWeight: 600, fontFamily: 'var(--display-font)', fontVariantNumeric: 'tabular-nums', outline: 'none' }}
                />
                {/* Asset selector — only when there's a token to switch to; otherwise the native coin is fixed. */}
                {tokens.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setAssetMenuOpen((o) => !o)}
                    aria-expanded={assetMenuOpen}
                    aria-label="Select asset"
                    style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-s)', background: 'transparent', color: 'var(--ink-900)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    {assetSym}
                    <span style={{ display: 'flex', color: 'var(--ink-500)' }}>
                      <ChevDownIcon size={15} />
                    </span>
                  </button>
                ) : (
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-500)' }}>{assetSym}</span>
                )}
                <button
                  type="button"
                  aria-pressed={maxMode}
                  disabled={maxLoading}
                  onClick={() => {
                    if (asset !== null) {
                      // Token "Max" = the full token balance (the fee is a separate native amount).
                      setAmount(formatToken(asset.amountAtomic, asset.decimals))
                      return
                    }
                    if (maxMode) {
                      setMaxMode(false)
                      setAmount('')
                      setFormFee(null)
                      return
                    }
                    enableMax()
                  }}
                  style={{ flex: 'none', minWidth: 48, height: 30, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border-s)', background: maxMode ? 'var(--red-soft)' : 'transparent', color: 'var(--primary)', fontSize: 12, fontWeight: 600, cursor: maxLoading ? 'default' : 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {maxLoading ? <span className="spinner spinner--xs" aria-label="Calculating" /> : 'Max'}
                </button>
              </div>
              {assetMenuOpen && (
                <div style={{ position: 'absolute', top: 90, right: 0, zIndex: 20, width: 168, background: 'var(--card-el)', border: '1px solid var(--border-s)', borderRadius: 11, boxShadow: 'var(--shadow)', overflow: 'hidden', padding: 4 }}>
                  {[null, ...tokens].map((a) => {
                    const isActive = (a?.id ?? null) === (asset?.id ?? null)
                    return (
                      <button
                        key={a?.id ?? brand.assetLabel}
                        type="button"
                        className="picker-row"
                        onClick={() => switchAsset(a)}
                        style={{ display: 'flex', alignItems: 'center', width: '100%', padding: '9px 11px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, fontWeight: 500, color: 'var(--ink-900)' }}
                      >
                        <span style={{ flex: 1 }}>{a === null ? brand.assetLabel : tokenLabels(a).ticker}</span>
                        {isActive && (
                          <span style={{ display: 'flex', color: 'var(--primary)' }}>
                            <CheckIcon size={15} />
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Network fee — a flat rate on this chain; for a token it's paid in the native coin. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 10, background: 'var(--well)' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-900)' }}>
                  Network fee{asset !== null && <span style={{ fontWeight: 500, color: 'var(--ink-500)' }}> · paid in {brand.assetLabel}</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 1 }}>Confirms in ~10s</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono)', color: 'var(--ink-700)' }}>
                {feeLoading ? '…' : formFee !== null ? `${formatNative(formFee)} ${brand.assetLabel}` : '—'}
              </div>
            </div>

            {feeBlocked && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '11px 13px', borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 32%, transparent)' }}>
                <span style={{ display: 'flex', flex: 'none', color: 'var(--warning)', marginTop: 1 }}>
                  <AlertIcon size={16} />
                </span>
                <div style={{ fontSize: 12.5, color: 'var(--ink-700)', lineHeight: 1.45 }}>
                  <span style={{ fontWeight: 600, color: 'var(--ink-900)' }}>You need a little {brand.assetLabel} to pay the network fee.</span> Add {brand.assetLabel} to send tokens.
                </div>
              </div>
            )}

            {feeShort && selectedCoins.size === 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '11px 13px', borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 32%, transparent)' }}>
                <span style={{ display: 'flex', flex: 'none', color: 'var(--warning)', marginTop: 1 }}>
                  <AlertIcon size={16} />
                </span>
                <div style={{ fontSize: 12.5, color: 'var(--ink-700)', lineHeight: 1.45 }}>
                  <span style={{ fontWeight: 600, color: 'var(--ink-900)' }}>Amount plus the network fee exceeds your spendable balance.</span> Lower the amount, or{' '}
                  <button type="button" onClick={enableMax} disabled={maxLoading} style={maxLinkStyle}>
                    send maximum
                  </button>{' '}
                  to empty it minus the fee.
                </div>
              </div>
            )}

            {/* Coin control — collapsed by default (automatic). Native sends only; a
               token send picks its own UTXOs. Manual selection feeds `outpoints`. */}
            {asset === null && spendableCoins.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => setCoinOpen((o) => !o)}
                  aria-expanded={coinOpen}
                  style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '15px 18px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                >
                  <span style={{ display: 'flex', flex: 'none', color: 'var(--ink-500)' }}>
                    <CoinsIcon size={18} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-900)' }}>Coin control</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 2 }}>
                      {selectedCoins.size > 0 ? `${String(selectedCoins.size)} coin${selectedCoins.size === 1 ? '' : 's'} selected` : 'Automatic (best selection)'}
                    </div>
                  </div>
                  <span style={{ display: 'flex', flex: 'none', color: 'var(--ink-500)' }}>{coinOpen ? <ChevDownIcon size={16} /> : <ChevRightIcon size={16} />}</span>
                </button>
                {coinOpen && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: 8 }}>
                    {spendableCoins.map((c) => {
                      const sel = selectedCoins.has(c.outpoint)
                      return (
                        <button
                          key={c.outpoint}
                          type="button"
                          onClick={() => toggleCoin(c.outpoint)}
                          aria-pressed={sel}
                          className="picker-row"
                          style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '10px 10px', borderRadius: 9, cursor: 'pointer', border: 'none', background: 'transparent', textAlign: 'left', fontFamily: 'inherit' }}
                        >
                          <span style={{ flex: 'none', width: 18, height: 18, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', border: sel ? 'none' : '1.5px solid var(--border-s)', background: sel ? 'var(--primary)' : 'transparent' }}>{sel && <CheckIcon size={12} />}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{c.label ?? c.address}</span>
                              {c.algo === 'falcon512' && <Pill tone="pq">PQ</Pill>}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--ink-500)', fontFamily: 'var(--mono)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.address}</div>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)' }}>{formatNative(c.valueAtomic)} {brand.assetLabel}</div>
                        </button>
                      )
                    })}
                    {selectedCoins.size > 0 && (
                      <div style={{ padding: '11px 12px 4px', marginTop: 4, borderTop: '1px solid var(--border)', fontSize: 12.5, fontWeight: 500, color: coinShort ? 'var(--warning)' : 'var(--ink-500)' }}>
                        Selected {formatNative(pickedAtomic.toString())}
                        {/* Exact need once the fee is known; before that be honest that the
                           fee comes on top instead of pretending need == amount. */}
                        {needAtomic !== null ? ` / need ${formatNative(needAtomic.toString())}` : amountParsed !== null ? ` / need ${formatNative(amountParsed.toString())} + fee` : ''} {brand.assetLabel}
                      </div>
                    )}
                    {coinShort && (
                      <div style={{ margin: '4px 8px 6px', padding: '9px 11px', borderRadius: 9, background: 'color-mix(in srgb, var(--warning) 15%, transparent)', color: 'var(--warning)', fontSize: 12, fontWeight: 500, lineHeight: 1.45 }}>
                        Selected coins don’t cover the amount plus the network fee. Add more inputs, lower the amount, or{' '}
                        <button type="button" onClick={enableMax} disabled={maxLoading} style={{ ...maxLinkStyle, color: 'var(--warning)' }}>
                          send maximum
                        </button>
                        .
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {error !== null && <div className="field-hint field-hint--error">{error}</div>}

            <Button fullWidth disabled={busy || feeBlocked || feeShort || coinShort || recipient.trim().length === 0 || amount.trim().length === 0} onClick={() => void review()}>
              {stage === 'building' ? 'Preparing…' : 'Review send'}
            </Button>
          </div>
        )}

        {stage === 'review' && (preview !== null || tokenPreview !== null) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, fontFamily: 'var(--display-font)', letterSpacing: '-0.01em', color: 'var(--ink-900)' }}>Review send</h2>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
              <div style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: 12, color: 'var(--ink-500)' }}>To</div>
                {matched !== null && <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)', marginTop: 3 }}>{matched.name}</div>}
                <div style={{ fontSize: 12.5, fontFamily: 'var(--mono)', color: 'var(--ink-700)', marginTop: 3, wordBreak: 'break-all' }}>{preview?.recipient ?? tokenPreview?.recipient ?? recipient.trim()}</div>
                {matched !== null ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: 'var(--success)' }}>
                    <CheckIcon size={14} />
                    Saved contact
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, padding: '7px 10px', borderRadius: 8, background: 'color-mix(in srgb, var(--warning) 13%, transparent)', fontSize: 12, fontWeight: 500, color: 'var(--warning)' }}>
                    <AlertIcon size={14} />
                    Not in your contacts — double-check every character before sending.
                  </div>
                )}
              </div>
              {tokenPreview !== null ? (
                <>
                  <ReviewRow label="Amount" value={`${formatToken(tokenPreview.tokenAmountAtomic, decimals)} ${assetSym}`} strong />
                  <ReviewRow label="Network fee" value={`${formatNative(tokenPreview.feeAtomic)} ${brand.assetLabel}`} />
                  <ReviewRow label="Signature" value={tokenPreview.signature} />
                </>
              ) : preview !== null ? (
                <>
                  <ReviewRow label="Amount" value={`${formatNative(preview.amountAtomic)} ${brand.assetLabel}`} />
                  <ReviewRow label="Network fee" value={`${formatNative(preview.feeAtomic)} ${brand.assetLabel}`} />
                  <ReviewRow label="Total" value={`${formatNative(preview.totalAtomic)} ${brand.assetLabel}`} strong />
                  <ReviewRow label="Signature" value={preview.signature} />
                </>
              ) : null}
            </div>
            {error !== null && <div className="field-hint field-hint--error">{error}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <Button
                variant="secondary"
                size="cta"
                style={{ width: 120, flex: 'none' }}
                onClick={() => {
                  setStage('form')
                  setError(null)
                }}
              >
                Back
              </Button>
              <Button size="cta" style={{ flex: 1 }} onClick={() => void confirm()}>
                Confirm &amp; send
              </Button>
            </div>
          </div>
        )}

        {stage === 'sending' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '40px 20px' }}>
            <span className="spinner" />
            <div style={{ marginTop: 18, fontSize: 16, fontWeight: 600, fontFamily: 'var(--display-font)', color: 'var(--ink-900)' }}>Broadcasting transaction…</div>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-500)' }}>Signed with ECDSA · sending to the network</div>
          </div>
        )}

        {stage === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', maxWidth: 320, margin: '0 auto' }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 60, height: 60, borderRadius: '50%', background: 'color-mix(in srgb, var(--success) 18%, transparent)', color: 'var(--success)' }}>
              <CheckIcon size={30} />
            </span>
            <div style={{ marginTop: 18, fontSize: 20, fontWeight: 600, fontFamily: 'var(--display-font)', color: 'var(--ink-900)' }}>Sent</div>
            {tokenPreview !== null ? (
              <div style={{ marginTop: 8, fontSize: 24, fontWeight: 600, fontFamily: 'var(--display-font)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)' }}>
                {formatToken(tokenPreview.tokenAmountAtomic, decimals)} {assetSym}
              </div>
            ) : preview !== null ? (
              <div style={{ marginTop: 8, fontSize: 24, fontWeight: 600, fontFamily: 'var(--display-font)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)' }}>{formatNative(preview.amountAtomic)} {brand.assetLabel}</div>
            ) : null}
            <div style={{ marginTop: 18, width: '100%', background: 'var(--well)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', textAlign: 'left' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-500)' }}>Transaction ID</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontFamily: 'var(--mono)', color: 'var(--ink-700)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{txid}</span>
                <button
                  type="button"
                  onClick={copyTxid}
                  aria-label="Copy transaction ID"
                  style={{ flex: 'none', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', borderRadius: 8, color: copied ? 'var(--success)' : 'var(--ink-500)', cursor: 'pointer' }}
                >
                  {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                </button>
              </div>
            </div>
            <Button size="cta" fullWidth onClick={onDone} style={{ marginTop: 18 }}>
              Done
            </Button>
          </div>
        )}

        {stage === 'failed' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', maxWidth: 320, margin: '0 auto' }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 60, height: 60, borderRadius: '50%', background: 'color-mix(in srgb, var(--danger) 16%, transparent)', color: 'var(--danger)' }}>
              <AlertIcon size={28} />
            </span>
            <div style={{ marginTop: 18, fontSize: 20, fontWeight: 600, fontFamily: 'var(--display-font)', color: 'var(--ink-900)' }}>Couldn&apos;t broadcast</div>
            <div style={{ marginTop: 10, fontSize: 13.5, color: 'var(--ink-500)', lineHeight: 1.5 }}>
              The network didn&apos;t accept the transaction. Nothing left your wallet — your balance is unchanged.
            </div>
            {error !== null && <div style={{ marginTop: 8, fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--ink-300)', wordBreak: 'break-all' }}>{error}</div>}
            <Button size="cta" fullWidth onClick={() => void confirm()} style={{ marginTop: 18 }}>
              Try again
            </Button>
            <Button
              variant="secondary"
              fullWidth
              onClick={() => {
                setStage('review')
                setError(null)
              }}
              style={{ marginTop: 10 }}
            >
              Back to details
            </Button>
          </div>
        )}

        <ContactDialog
          open={contactOpen}
          onClose={() => setContactOpen(false)}
          initialAddress={recipient.trim()}
          onSubmit={async (name, address) => {
            const updated = await wallet.addContact(name, address)
            cacheSetContacts(updated)
            setRecipient(address)
          }}
        />
      </div>
    </Screen>
  )
}

// Inline text-button used inside the insufficient-funds warnings for the
// "send maximum" shortcut — looks like a link, not a chunky button.
const maxLinkStyle: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--primary)',
  font: 'inherit',
  fontWeight: 600,
  textDecoration: 'underline',
  cursor: 'pointer',
}

// One review line: muted label, mono tabular value; `strong` for the Total row.
function ReviewRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }): ReactNode {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '13px 16px', borderTop: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13, fontWeight: strong ? 600 : 400, color: strong ? 'var(--ink-900)' : 'var(--ink-500)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: strong ? 700 : 600, fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)' }}>{value}</span>
    </div>
  )
}
