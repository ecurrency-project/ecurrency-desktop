import { useEffect, useState } from 'react'
import type { AddressAlgo, KeyInspection, SendPreview } from '../../shared/protocol'
import { formatNative, parseNative } from '../lib/format'
import { wallet } from '../lib/wallet'
import { useAssetLabel } from '../lib/walletData'
import { AlertIcon, AtomIcon, Button, Modal, Pill, Segmented, TextArea, TextField } from '../ui'

// "Send from a key" — the one-dialog quick path: paste a WIF, see its balance,
// send, done. Backed by the EPHEMERAL sweep session in main (sweep.ts): the key
// is materialized on scan, held in memory only between scan and confirm/cancel
// (or lock), and never written to disk or the registry. The active wallet is
// untouched throughout — Sparrow's "Sweep Private Key" model.
//
// Typical journey (~30s): dumpprivkey on the node → paste here → Max → send to
// your own wallet. Max + send is a full sweep: the address is emptied, no
// change output, and the key is wiped.

type Step = 'key' | 'form' | 'review' | 'done'

const ALGO_LABEL: Record<AddressAlgo, string> = { ecdsa: 'ECDSA', schnorr: 'Schnorr', falcon512: 'Falcon-512' }

export function SendFromKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const asset = useAssetLabel()
  const [step, setStep] = useState<Step>('key')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Key step.
  const [wif, setWif] = useState('')
  const [inspection, setInspection] = useState<KeyInspection | null>(null)
  const [keyAlgo, setKeyAlgo] = useState<AddressAlgo | null>(null)

  // Scan result + form / review / done.
  const [scanned, setScanned] = useState<{ address: string; balanceAtomic: string } | null>(null)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [sendMax, setSendMax] = useState(false)
  const [preview, setPreview] = useState<SendPreview | null>(null)
  const [txid, setTxid] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setStep('key')
      setBusy(false)
      setError(null)
      setWif('')
      setInspection(null)
      setKeyAlgo(null)
      setScanned(null)
      setRecipient('')
      setAmount('')
      setSendMax(false)
      setPreview(null)
      setTxid(null)
    }
  }, [open])

  // Live key preview — same debounce + inspect flow as the import dialog.
  useEffect(() => {
    if (!open || step !== 'key') return undefined
    setInspection(null)
    setKeyAlgo(null)
    setError(null)
    const text = wif.trim()
    if (text === '') return undefined
    let active = true
    const timer = setTimeout(() => {
      wallet
        .inspectKey(text)
        .then((res) => {
          if (!active) return
          setInspection(res)
          setKeyAlgo(res.candidates[0] ?? null)
        })
        .catch((e) => {
          if (active) setError((e as Error).message)
        })
    }, 300)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, step, wif])

  // Materialize the key in main and read its balance. Nothing is stored.
  const proceed = async (): Promise<void> => {
    if (keyAlgo === null) return
    setBusy(true)
    setError(null)
    try {
      setScanned(await wallet.sweepScan(wif, keyAlgo))
      setStep('form')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const review = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      let atomic: string | undefined
      if (!sendMax) {
        try {
          atomic = parseNative(amount).toString()
        } catch {
          throw new Error('Enter a valid amount.')
        }
      }
      setPreview(await wallet.sweepBuild(recipient.trim(), atomic, sendMax))
      setStep('review')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await wallet.sweepConfirm()
      setTxid(res.txid)
      setStep('done')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Closing before confirm abandons the sweep — main wipes the key. After
  // 'done' the key is already gone; just close.
  const close = (): void => {
    if (busy) return
    if (scanned !== null && step !== 'done') void wallet.sweepCancel().catch(() => {})
    onClose()
  }

  const emptyBalance = scanned !== null && BigInt(scanned.balanceAtomic) === 0n

  const footer =
    step === 'key' ? (
      <>
        <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button style={{ flex: 1 }} disabled={busy || keyAlgo === null} onClick={() => void proceed()}>
          {busy ? 'Scanning…' : 'Continue'}
        </Button>
      </>
    ) : step === 'form' ? (
      <>
        <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button style={{ flex: 1 }} disabled={busy || emptyBalance || recipient.trim() === '' || (!sendMax && amount.trim() === '')} onClick={() => void review()}>
          {busy ? 'Preparing…' : 'Review'}
        </Button>
      </>
    ) : step === 'review' ? (
      <>
        <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={() => setStep('form')}>
          Back
        </Button>
        <Button style={{ flex: 1 }} disabled={busy} onClick={() => void confirm()}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </>
    ) : (
      <Button style={{ flex: 1 }} onClick={onClose}>
        Done
      </Button>
    )

  const subtitle =
    step === 'key'
      ? 'Paste a private key and send its funds — the key is never stored'
      : step === 'form'
        ? 'The key lives in memory only until you finish; your own wallet is untouched'
        : step === 'review'
          ? 'Check the details — this cannot be undone'
          : undefined

  return (
    <Modal open={open} onClose={close} title="Send from a key" subtitle={subtitle} width={470} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 4 }}>
        {step === 'key' && (
          <>
            <TextArea
              label="Private key"
              mono
              rows={3}
              value={wif}
              onChange={(e) => setWif(e.target.value)}
              placeholder="WIF private key (e.g. from the node's dumpprivkey)"
              aria-label="Private key"
              state={error !== null ? 'error' : 'default'}
              hint={error ?? 'Held in memory for this flow only — nothing is written to disk.'}
            />
            {inspection !== null && keyAlgo !== null && (
              <>
                {inspection.candidates.length > 1 && (
                  <Segmented ariaLabel="Key algorithm" value={keyAlgo} onChange={setKeyAlgo} options={inspection.candidates.map((a) => ({ value: a, label: ALGO_LABEL[a] }))} />
                )}
                <div style={{ background: 'var(--well)', border: '1px solid var(--border)', borderRadius: 12, padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--ink-500)' }}>Address of this key — confirm it is the one you expect</span>
                    {keyAlgo === 'falcon512' && (
                      <Pill tone="pq" icon={<AtomIcon size={12} />}>
                        Post-quantum
                      </Pill>
                    )}
                  </div>
                  <code style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-700)', lineHeight: 1.5, wordBreak: 'break-all' }}>{inspection.addresses[keyAlgo] ?? '—'}</code>
                </div>
              </>
            )}
          </>
        )}

        {step === 'form' && scanned !== null && (
          <>
            <div style={{ background: 'var(--well)', border: '1px solid var(--border)', borderRadius: 12, padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 11.5, color: 'var(--ink-500)' }}>Balance on this key</span>
                <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ink-900)' }}>{formatNative(scanned.balanceAtomic)} {asset}</span>
              </div>
              <code style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-500)', wordBreak: 'break-all' }}>{scanned.address}</code>
            </div>
            {emptyBalance ? (
              <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', border: '1px solid var(--border)', background: 'var(--well)', borderRadius: 12, padding: '10px 12px' }}>
                <span style={{ flex: 'none', color: 'var(--warning)', display: 'flex', marginTop: 1 }}>
                  <AlertIcon size={15} />
                </span>
                <span style={{ fontSize: 12, color: 'var(--ink-700)', lineHeight: 1.55 }}>Nothing to send — this key holds no spendable {asset}. Close to finish; the key will be wiped from memory.</span>
              </div>
            ) : (
              <>
                <TextField label="Send to" mono value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Recipient address (e.g. your own wallet)" aria-label="Recipient address" />
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label={`Amount (${asset})`}
                      mono
                      value={sendMax ? '' : amount}
                      disabled={sendMax}
                      onChange={(e) => {
                        setAmount(e.target.value)
                        setSendMax(false)
                      }}
                      placeholder={sendMax ? 'Entire balance (minus fee)' : '0.0'}
                      aria-label={`Amount in ${asset}`}
                    />
                  </div>
                  <Button variant={sendMax ? 'primary' : 'secondary'} style={{ height: 38 }} disabled={busy} onClick={() => setSendMax((m) => !m)}>
                    {sendMax ? 'Max ✓' : 'Max'}
                  </Button>
                </div>
                {sendMax && <div style={{ fontSize: 12, color: 'var(--ink-500)', lineHeight: 1.5 }}>Sweeping the entire balance — the exact amount after the fee appears on review.</div>}
              </>
            )}
            {error !== null && <div className="field-hint field-hint--error">{error}</div>}
          </>
        )}

        {step === 'review' && preview !== null && (
          <>
            <div style={{ background: 'var(--well)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              <ReviewRow label="To" value={preview.recipient} mono />
              <ReviewRow label="Amount" value={`${formatNative(preview.amountAtomic)} ${asset}`} />
              <ReviewRow label="Network fee" value={`${formatNative(preview.feeAtomic)} ${asset}`} />
              {preview.changeAtomic !== '0' && <ReviewRow label="Change" value={`${formatNative(preview.changeAtomic)} ${asset} — returns to the key's address`} />}
              <ReviewRow label="Signature" value={preview.signature} />
            </div>
            {sendMax && <div style={{ fontSize: 12, color: 'var(--ink-500)', lineHeight: 1.5 }}>Full sweep: the address is emptied, no change output, and the key is wiped after sending.</div>}
            {error !== null && <div className="field-hint field-hint--error">{error}</div>}
          </>
        )}

        {step === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--success)' }}>Transaction broadcast</div>
            <div style={{ background: 'var(--well)', border: '1px solid var(--border)', borderRadius: 12, padding: '11px 13px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ink-500)', marginBottom: 4 }}>Transaction id</div>
              <code style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-700)', wordBreak: 'break-all' }}>{txid ?? '—'}</code>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-500)', lineHeight: 1.5 }}>The key has been wiped from memory — nothing was stored on this device.</div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ flex: 'none', width: 92, color: 'var(--ink-500)' }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--ink-900)', wordBreak: 'break-all', fontFamily: mono ? 'var(--mono)' : undefined, fontSize: mono ? 12 : undefined }}>{value}</span>
    </div>
  )
}
