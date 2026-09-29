import { useState, type CSSProperties } from 'react'
import { SensitiveContent, secretInputProps } from '../components/SensitiveContent'
import { useSensitiveSession } from '../lib/useSensitiveSession'
import { useOperation } from '../lib/useOperation'
import { passwordError } from '../lib/passwordError'
import { wallet } from '../lib/wallet'
import { Button, Logo, PasswordField, PasswordStrength, Screen, Subtitle, TextArea, TextField, Title } from '../ui'

// The lock screen. Shown when a vault exists but is sealed — on launch, and when the
// main process auto-locks after inactivity. Unlocking is delegated to main. A "forgot
// password" path re-creates the wallet from its recovery phrase + a new password: with
// the same phrase this is non-destructive (the app-data key is seed-derived).
export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [view, setView] = useState<'unlock' | 'restore'>('unlock')
  const [restored, setRestored] = useState(false)
  return view === 'unlock' ? <UnlockForm restored={restored} onUnlocked={onUnlocked} onForgot={() => { setRestored(false); setView('restore') }} /> : <RestoreForm onRestored={() => { setRestored(true); setView('unlock') }} onBack={() => setView('unlock')} />
}

function UnlockForm({ onUnlocked, onForgot, restored }: { onUnlocked: () => void; onForgot: () => void; restored: boolean }) {
  const [pw, setPw] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(): Promise<void> {
    if (busy || pw.length === 0) return
    setBusy(true)
    setErrorMsg(null)
    try {
      await wallet.unlock(pw)
      setPw('')
      onUnlocked()
    } catch (e) {
      setErrorMsg(passwordError(e))
      setPw('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen center>
      <div style={{ maxWidth: 360, width: '100%', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Logo size={46} />
        <div style={{ marginTop: 18 }}>
          <Title>Welcome back</Title>
        </div>
        <Subtitle>{restored ? 'Wallet restored. Enter your new password to unlock.' : 'Enter your password to unlock.'}</Subtitle>
        <div style={{ width: '100%', marginTop: 22, textAlign: 'left' }}>
          <TextField
            type="password"
            autoComplete="current-password"
            spellCheck={false}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
            }}
            autoFocus
            placeholder="Password"
            aria-label="Password"
            state={errorMsg !== null ? 'error' : 'default'}
            hint={errorMsg ?? undefined}
            style={{ textAlign: 'center' }}
          />
        </div>
        <Button fullWidth size="cta" disabled={busy || pw.length === 0} onClick={() => void submit()} style={{ marginTop: 18 }}>
          Unlock
        </Button>
        <button type="button" disabled={busy} onClick={onForgot} style={linkButton}>
          Forgot password? Restore from recovery phrase
        </button>
      </div>
    </Screen>
  )
}

function RestoreForm({ onRestored, onBack }: { onRestored: () => void; onBack: () => void }) {
  const [phrase, setPhrase] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const operation = useOperation()
  const { busy } = operation
  const access = useSensitiveSession('seed-input')
  const back = (): void => {
    if (operation.pending.current) return
    access.controller.stop('closed'); setPhrase(''); setPw(''); setConfirm(''); onBack()
  }
  const valid = phrase.trim().length > 0 && pw.length >= 8 && pw === confirm

  async function submit(): Promise<void> {
    if (!valid || !access.controller.ticket() || !operation.start()) return
    setError(null)
    try {
      await wallet.restoreWallet(phrase, pw)
      if (!operation.current()) return
      setPhrase(''); setPw(''); setConfirm(''); access.controller.stop('completed')
      onRestored()
    } catch (e) {
      if (operation.current()) setError(e instanceof Error && e.message !== '' ? e.message : 'Could not restore from that phrase.')
    } finally {
      operation.finish()
    }
  }

  return (
    <Screen center>
      <div style={{ maxWidth: 380, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Logo size={40} />
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Title>Restore wallet</Title>
        </div>
        <Subtitle>Enter your recovery phrase and choose a new password.</Subtitle>
        <SensitiveContent access={access} action="Enter recovery phrase" layout="screen">
          <div style={{ width: '100%', marginTop: 20, display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'left' }}>
            <TextArea {...secretInputProps}
              label="Recovery phrase"
              mono
              rows={3}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="word1 word2 … (12 or 24 words)"
              aria-label="Recovery phrase"
              state={error !== null ? 'error' : 'default'}
              hint="Re-creates your wallet on this device. Use the phrase for this wallet."
            />
            <div>
              <PasswordField autoComplete="new-password" label="New password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" aria-label="New password" />
              {pw.length > 0 && <PasswordStrength password={pw} />}
            </div>
            <PasswordField autoComplete="new-password" label="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" aria-label="Confirm password" />
            {confirm.length > 0 && pw !== confirm && <div className="field-hint field-hint--error">Passwords don&apos;t match yet.</div>}
          </div>
          <Button fullWidth size="cta" disabled={busy || !valid} onClick={() => void submit()} style={{ marginTop: 18 }}>
            {busy ? 'Restoring…' : 'Restore wallet'}
          </Button>
        </SensitiveContent>
        {busy && <p role="status">Restoring wallet…</p>}
        {error !== null && <p role="alert" className="field-hint field-hint--error">{error}</p>}
        <button type="button" disabled={busy} onClick={back} style={linkButton}>
          Back to unlock
        </button>
      </div>
    </Screen>
  )
}

const linkButton: CSSProperties = {
  marginTop: 16,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--ink-500)',
}
