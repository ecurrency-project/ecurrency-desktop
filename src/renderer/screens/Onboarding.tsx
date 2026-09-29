import { useEffect, useMemo, useRef, useState } from 'react'
import { brand } from '../brand'
import { RecoveryPhrase } from '../components/RecoveryPhrase'
import { SensitiveContent, secretInputProps } from '../components/SensitiveContent'
import { useSensitiveSession } from '../lib/useSensitiveSession'
import { useOperation } from '../lib/useOperation'
import { wallet } from '../lib/wallet'
import { AtomIcon, Button, CheckIcon, ChevLeftIcon, CopyIcon, EyeIcon, Logo, PasswordField, PasswordStrength, Screen, ShieldIcon, Subtitle, Switch, TextArea, TextField, Title } from '../ui'

// Onboarding is a self-contained step machine. The vault is created in the main
// process via window.wallet.create() — for a NEW wallet at the moment the user
// confirms their backup; for an IMPORT when they set a password on the entered
// phrase. The mnemonic/password live only in this component's transient state and
// are never persisted in the renderer.
type Step = 'welcome' | 'password' | 'seed' | 'confirm' | 'import' | 'done'
type Mode = 'create' | 'import'

// Pick three distinct word positions to quiz on, in ascending order.
function pickThree(count: number): number[] {
  const idx = new Set<number>()
  while (idx.size < Math.min(3, count)) idx.add(Math.floor(Math.random() * count))
  return [...idx].sort((a, b) => a - b)
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('welcome')
  const [mode, setMode] = useState<Mode>('create')
  const [pw, setPw] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [ack, setAck] = useState(false)
  const [confirmIdx, setConfirmIdx] = useState<number[]>([])
  const [confirmVals, setConfirmVals] = useState<string[]>(['', '', ''])
  const [importText, setImportText] = useState('')
  const [importValid, setImportValid] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operation = useOperation()
  const { busy } = operation
  const generating = useRef(false)
  const validation = useRef(0)
  // The confirm step shows no secret — the user types three words from their own
  // backup — so it runs without a sensitive session: no timer, no capture shield.
  const access = useSensitiveSession(step === 'import' ? 'seed-input' : 'onboarding', step === 'seed' || step === 'import', () => {
    setRevealed(false); setAck(false); generating.current = false
    validation.current++
  })
  function clearDraft(): void {
    setMnemonic(''); setImportText(''); setImportValid(false); setPw(''); setPwConfirm('')
    setConfirmVals(['', '', '']); setConfirmIdx([]); setRevealed(false); setAck(false)
  }
  function cancel(): void {
    if (operation.pending.current) return
    access.controller.stop('closed'); clearDraft(); setError(null); setStep('welcome')
  }
  async function showPhrase(): Promise<void> {
    const ticket = access.controller.ticket()
    if (!ticket || generating.current) return
    generating.current = true
    setError(null)
    try {
      const phrase = mnemonic || await wallet.generateMnemonic(ticket.sessionId)
      if (!access.controller.current(ticket)) return
      setMnemonic(phrase); setRevealed(true)
    } catch {
      if (access.controller.current(ticket)) setError('Could not prepare the recovery phrase. Try again.')
    } finally { if (access.controller.current(ticket)) generating.current = false }
  }

  const words = useMemo(() => (mnemonic ? mnemonic.split(' ') : []), [mnemonic])
  const pwOk = pw.length >= 8 && pw === pwConfirm
  const importNormalized = importText.trim().replace(/\s+/g, ' ')

  async function seal(phrase: string): Promise<void> {
    if (!operation.start()) return
    setError(null)
    try {
      await wallet.create(phrase, pw)
      if (!operation.current()) return
      clearDraft()
      access.controller.stop('completed')
      setStep('done')
    } catch (e) {
      if (operation.current()) setError((e as Error).message)
    } finally {
      operation.finish()
    }
  }

  async function pwContinue(): Promise<void> {
    if (!pwOk) return
    if (mode === 'create') {
      setRevealed(false)
      setAck(false)
      setStep('seed')
    } else {
      await seal(importNormalized)
    }
  }

  function startConfirm(): void {
    if (!access.controller.ticket() || !revealed) return
    access.controller.stop('step')
    setConfirmIdx(pickThree(words.length))
    setConfirmVals(['', '', ''])
    setStep('confirm')
  }

  const confirmOk = confirmIdx.length === 3 && confirmIdx.every((wi, i) => (confirmVals[i] ?? '').trim().toLowerCase() === words[wi])

  function setImport(value: string): void {
    setImportText(value)
    if (value.trim().replace(/\s+/g, ' ') === importNormalized) return
    validation.current++
    setImportValid(false)
  }
  useEffect(() => {
    if (step !== 'import' || !access.active) return
    const ticket = access.controller.ticket()
    const request = ++validation.current
    const timer = setTimeout(() => {
      void wallet.validateMnemonic(importNormalized).then((valid) => {
        if (request === validation.current && access.controller.current(ticket)) setImportValid(valid)
      }).catch(() => {})
    }, 200)
    return () => { clearTimeout(timer) }
  }, [step, importNormalized, access.active, access.controller])

  function back(): void {
    if (operation.pending.current) return
    access.controller.stop('step')
    setError(null)
    if (step === 'password') cancel()
    else if (step === 'seed') setStep('password')
    else if (step === 'confirm') setStep('seed')
    else if (step === 'import') cancel()
  }

  return (
    <Screen center>
      {step !== 'welcome' && step !== 'done' && (
        <Button variant="ghost" disabled={busy} onClick={back} style={{ position: 'absolute', top: 16, left: 16, height: 34, padding: '0 12px 0 7px', fontWeight: 500, gap: 5 }}>
          <ChevLeftIcon size={18} />
          Back
        </Button>
      )}

      <div style={{ width: '100%' }}>
        {step === 'welcome' && (
          <div style={{ maxWidth: 380, margin: '0 auto', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <Logo size={54} />
            <div style={{ marginTop: 20 }}>
              <Title size={26}>{brand.productName}</Title>
            </div>
            <Subtitle>{brand.tagline}</Subtitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11, width: '100%', marginTop: 32 }}>
              <Button
                fullWidth
                size="cta"
                onClick={() => {
                  setMode('create')
                  setStep('password')
                }}
              >
                Create a new wallet
              </Button>
              <Button
                fullWidth
                size="cta"
                variant="secondary"
                onClick={() => {
                  setMode('import')
                  setStep('import')
                }}
              >
                I already have a wallet
              </Button>
            </div>
            <p style={{ margin: '22px 0 0', fontSize: 12, color: 'var(--ink-500)', lineHeight: 1.5 }}>
              By continuing you agree to our <span style={{ color: 'var(--ink-700)', textDecoration: 'underline' }}>Terms</span> and{' '}
              <span style={{ color: 'var(--ink-700)', textDecoration: 'underline' }}>Privacy Policy</span>.
            </p>
          </div>
        )}

        {step === 'password' && (
          <div style={{ maxWidth: 420, margin: '0 auto' }}>
            <Title>Set a password</Title>
            <Subtitle>This password unlocks the app on this device. It isn&apos;t your recovery — your 12-word phrase is what restores the wallet.</Subtitle>
            <div style={{ marginTop: 22 }}>
              <PasswordField autoComplete="new-password" label="Password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" aria-label="Password" />
            </div>
            <PasswordStrength password={pw} />
            <div style={{ marginTop: 16 }}>
              <PasswordField autoComplete="new-password" label="Confirm password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} placeholder="Re-enter your password" aria-label="Confirm password" />
            </div>
            {pwConfirm.length > 0 && pw !== pwConfirm && <div className="field-hint field-hint--error">Passwords don&apos;t match yet.</div>}
            <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 14 }}>We can&apos;t recover this password for you.</div>
            {error && <div className="field-hint field-hint--error">{error}</div>}
            <Button fullWidth size="cta" disabled={!pwOk || busy} onClick={() => void pwContinue()} style={{ marginTop: 20 }}>
              {mode === 'import' ? (busy ? 'Restoring…' : 'Restore wallet') : 'Continue'}
            </Button>
          </div>
        )}

        {step === 'seed' && (
          <div style={{ maxWidth: 480, margin: '0 auto' }}>
            <Title>Save your recovery phrase</Title>
            <Subtitle>If you lose this device, these 12 words restore your wallet anywhere. Write them on paper. Don&apos;t screenshot.</Subtitle>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 14, padding: '8px 12px', borderRadius: 9, background: 'color-mix(in srgb, var(--warning) 13%, transparent)', color: 'var(--warning)', width: 'fit-content', fontSize: 12.5, fontWeight: 600 }}>
              <ShieldIcon size={16} />
              Don&apos;t share these with anyone
            </div>
            {!access.active && <RecoveryPhrase words={[]} shown={false} />}
            <SensitiveContent access={access} action="Show recovery phrase" layout="screen" onStart={() => void showPhrase()}>
              <RecoveryPhrase words={words} shown={revealed} />
              {!revealed && error && <Button fullWidth onClick={() => void showPhrase()} style={{ marginTop: 12 }}><EyeIcon size={16} />Try again</Button>}
              {error && <div role="alert" className="field-hint field-hint--error">{error}</div>}
              <p style={{ fontSize: 12, color: 'var(--pq)' }}><AtomIcon size={15} /> These words protect both your classical and post-quantum addresses.</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 18, padding: '13px 14px', borderRadius: 11, border: '1px solid var(--border)', background: 'var(--well)' }}>
                <Switch checked={ack} onChange={setAck} label="I've saved these words somewhere safe" />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--ink-900)' }}>I&apos;ve saved these words somewhere safe</span>
              </div>
              <Button fullWidth size="cta" disabled={!ack || !revealed} onClick={startConfirm} style={{ marginTop: 16 }}>
                I&apos;ve written it down
              </Button>
            </SensitiveContent>
          </div>
        )}

        {step === 'confirm' && (
          <div style={{ maxWidth: 420, margin: '0 auto' }}>
            <Title>Confirm your phrase</Title>
            <Subtitle>Just to be sure you saved it — enter these three words from your phrase.</Subtitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 22 }}>
              {confirmIdx.map((wi, i) => {
                const val = confirmVals[i] ?? ''
                const matched = val.trim().toLowerCase() === words[wi]
                return (
                  <TextField
                    {...secretInputProps}
                    key={wi}
                    mono
                    label={`Word #${wi + 1}`}
                    value={val}
                    onChange={(e) => setConfirmVals((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                    placeholder="Type the word"
                    aria-label={`Word ${wi + 1}`}
                    state={val.length === 0 ? 'default' : matched ? 'success' : 'error'}
                  />
                )
              })}
            </div>
            <Button fullWidth size="cta" disabled={!confirmOk || busy} onClick={() => void seal(mnemonic)} style={{ marginTop: 20 }}>
              {busy ? 'Creating…' : 'Confirm'}
            </Button>
            {busy && <p role="status">Creating wallet…</p>}
            {error && <p role="alert" className="field-hint field-hint--error">{error}</p>}
          </div>
        )}

        {step === 'import' && (
          <div style={{ maxWidth: 460, margin: '0 auto' }}>
            <Title>Restore your wallet</Title>
            <Subtitle>Enter the 12-word recovery phrase from your other device, separated by spaces.</Subtitle>
            <SensitiveContent access={access} action="Enter recovery phrase" layout="screen">
              <div style={{ position: 'relative', marginTop: 20 }}>
                <TextArea
                  {...secretInputProps}
                  label="Recovery phrase"
                  mono
                  rows={4}
                  value={importText}
                  onChange={(e) => setImport(e.target.value)}
                  placeholder="word1  word2  word3  …"
                  aria-label="Recovery phrase"
                  state={importText.length > 0 && importValid ? 'success' : 'default'}
                  hint={importText.length === 0 ? 'Enter your 12 words, separated by spaces.' : importValid ? 'Valid recovery phrase' : 'Not a valid 12-word phrase yet.'}
                  style={{ height: 120, borderRadius: 12 }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const ticket = access.controller.ticket()
                    void navigator.clipboard.readText().then((text) => { if (access.controller.current(ticket)) setImport(text) }).catch(() => {})
                  }}
                  style={{ position: 'absolute', top: 10, right: 10, display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 11px', borderRadius: 8, border: '1px solid var(--border-s)', background: 'var(--card-el)', color: 'var(--ink-700)', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
                >
                  <CopyIcon size={14} />
                  Paste
                </button>
              </div>
              <Button fullWidth size="cta" disabled={!importValid} onClick={() => { access.controller.stop('step'); setStep('password') }} style={{ marginTop: 18 }}>
                Continue
              </Button>
            </SensitiveContent>
          </div>
        )}

        {step === 'done' && (
          <div style={{ maxWidth: 380, margin: '0 auto', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 64, height: 64, borderRadius: '50%', background: 'color-mix(in srgb, var(--success) 18%, transparent)', color: 'var(--success)' }}>
              <CheckIcon size={32} />
            </span>
            <div style={{ marginTop: 20 }}>
              <Title size={24}>You&apos;re all set</Title>
            </div>
            <Subtitle>Your wallet is ready — secured with Falcon-512 post-quantum keys.</Subtitle>
            <Button fullWidth size="cta" onClick={onComplete} style={{ marginTop: 28 }}>
              Open my wallet
            </Button>
          </div>
        )}
      </div>
    </Screen>
  )
}
