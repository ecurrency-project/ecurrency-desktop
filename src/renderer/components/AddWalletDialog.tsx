import { useEffect, useState } from 'react'
import type { AddressAlgo, KeyInspection, WatchInput } from '../../shared/protocol'
import { brand } from '../brand'
import { resetWalletData, setWallets, useWallets } from '../lib/walletData'
import { wallet } from '../lib/wallet'
import { Alert, AtomIcon, Button, Modal, PasswordField, Pill, Segmented, TextArea, TextField } from '../ui'

type Mode = 'watch' | 'seed' | 'key'
type Kind = 'descriptor' | 'xpub' | 'addresses'

const MODES: { value: Mode; label: string }[] = [
  { value: 'watch', label: 'Watch-only' },
  { value: 'seed', label: 'Recovery phrase' },
  { value: 'key', label: 'Private key' },
]

const ALGO_LABEL: Record<AddressAlgo, string> = { ecdsa: 'ECDSA', schnorr: 'Schnorr', falcon512: 'Falcon-512' }

const KINDS: { value: Kind; label: string }[] = [
  { value: 'descriptor', label: 'Descriptor' },
  { value: 'xpub', label: 'Account xpub' },
  { value: 'addresses', label: 'Addresses' },
]

const PLACEHOLDER: Record<Kind, string> = {
  descriptor: 'Paste the watch descriptor exported from the source wallet',
  xpub: 'xpub…',
  addresses: `One ${brand.assetName} address per line`,
}

const HELP: Record<Kind, string> = {
  descriptor: 'Follows both the classical and the Falcon (post-quantum) branches.',
  xpub: 'An account-level xpub — follows the classical branch only.',
  addresses: 'Watches exactly the addresses you paste, one per line.',
}

function toInput(kind: Kind, text: string): WatchInput {
  if (kind === 'xpub') return { kind: 'xpub', xpub: text.trim() }
  if (kind === 'addresses') return { kind: 'addresses', addresses: text.split(/\r?\n/) }
  return { kind: 'descriptor', text: text.trim() }
}

// Add a wallet: either a watch-only source (descriptor/xpub/addresses) or a second
// seed imported from its recovery phrase. Presentational shell around the main-process
// add calls; validation errors surface inline. Fields reset each time the dialog opens,
// and the new wallet is switched to on success.
export function AddWalletDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallets = useWallets()
  const [mode, setMode] = useState<Mode>('watch')
  const [kind, setKind] = useState<Kind>('descriptor')
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [inspection, setInspection] = useState<KeyInspection | null>(null)
  const [keyAlgo, setKeyAlgo] = useState<AddressAlgo | null>(null)

  useEffect(() => {
    if (open) {
      setMode('watch')
      setKind('descriptor')
      setLabel('')
      setText('')
      setPassphrase('')
      setError(null)
      setBusy(false)
      setInspection(null)
      setKeyAlgo(null)
    }
  }, [open])

  // Live key preview (key mode): debounce the pasted text, then ask main which
  // algorithms the WIF admits and the address each would watch — so the user
  // confirms against the expected address BEFORE anything is stored.
  useEffect(() => {
    if (mode !== 'key') return undefined
    setInspection(null)
    setKeyAlgo(null)
    setError(null)
    const wif = text.trim()
    if (wif === '') return undefined
    let active = true
    const timer = setTimeout(() => {
      wallet
        .inspectKey(wif)
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
  }, [mode, text])

  const add = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const before = wallets.map((w) => w.id)
      const list =
        mode === 'seed'
          ? await wallet.addSeedWallet(label, text, passphrase.trim() === '' ? undefined : passphrase)
          : mode === 'key'
            ? await wallet.addKeyWallet(label, text, keyAlgo ?? undefined)
            : await wallet.addWatchWallet(label, toInput(kind, text))
      // Best-effort hygiene: if the clipboard still holds the pasted key, wipe it.
      if (mode === 'key') {
        try {
          if ((await navigator.clipboard.readText()).trim() === text.trim()) {
            await navigator.clipboard.writeText('')
          }
        } catch {
          // Clipboard access can be denied — nothing to clean up then.
        }
      }
      // Switch to the wallet we just added (the id that wasn't present before).
      const created = list.find((w) => !before.includes(w.id))
      if (created !== undefined) {
        setWallets(await wallet.switchWallet(created.id))
        resetWalletData()
      } else {
        setWallets(list)
      }
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button style={{ flex: 1 }} disabled={busy || text.trim().length === 0 || (mode === 'key' && keyAlgo === null)} onClick={() => void add()}>
        {busy ? 'Adding…' : 'Add wallet'}
      </Button>
    </>
  )

  const subtitle =
    mode === 'seed'
      ? 'Import a wallet from its recovery phrase — its seed is stored encrypted on this device'
      : mode === 'key'
        ? 'Import a single private key — one fixed address, stored encrypted on this device'
        : "Follow a wallet's balance without its keys"
  return (
    <Modal open={open} onClose={onClose} title="Add wallet" subtitle={subtitle} width={460} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 4 }}>
        <Segmented options={MODES} value={mode} onChange={setMode} ariaLabel="Wallet type" />
        <TextField label="Name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={mode === 'seed' ? 'e.g. Savings' : 'e.g. Cold vault'} aria-label="Wallet name" />
        {mode === 'seed' ? (
          <>
            <TextArea
              label="Recovery phrase"
              mono
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="word1 word2 … (12 or 24 words)"
              aria-label="Recovery phrase"
              state={error !== null ? 'error' : 'default'}
              hint={error ?? 'The 12- or 24-word phrase of the wallet to import.'}
            />
            <PasswordField label="Passphrase (optional)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="BIP39 passphrase, if the wallet uses one" aria-label="BIP39 passphrase" />
          </>
        ) : mode === 'key' ? (
          <>
            <TextArea
              label="Private key"
              mono
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="WIF private key (e.g. from the node's dumpprivkey)"
              aria-label="Private key"
              state={error !== null ? 'error' : 'default'}
              hint={error ?? 'One key = one fixed address. Change from sends returns to that same address.'}
            />
            {inspection !== null && keyAlgo !== null && (
              <>
                {inspection.candidates.length > 1 && (
                  <Segmented ariaLabel="Key algorithm" value={keyAlgo} onChange={setKeyAlgo} options={inspection.candidates.map((a) => ({ value: a, label: ALGO_LABEL[a] }))} />
                )}
                <div style={{ background: 'var(--well)', border: '1px solid var(--border)', borderRadius: 12, padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--ink-500)' }}>Address to watch — confirm it is the one you expect</span>
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
            <Alert variant="caution">
                <span>
                Your recovery phrase does <strong>not</strong> back up this wallet — keep a separate backup of the key itself. Anyone holding the key can spend these funds.
              </span>
              </Alert>
          </>
        ) : (
          <>
            <Segmented options={KINDS} value={kind} onChange={setKind} ariaLabel="Watch source type" />
            {kind === 'xpub' ? (
              <TextField
                label="Account xpub"
                mono
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={PLACEHOLDER[kind]}
                aria-label="Account xpub"
                state={error !== null ? 'error' : 'default'}
                hint={error ?? HELP[kind]}
              />
            ) : (
              <TextArea
                label={kind === 'descriptor' ? 'Watch descriptor' : 'Addresses'}
                mono
                rows={kind === 'descriptor' ? 4 : 6}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={PLACEHOLDER[kind]}
                aria-label={kind === 'descriptor' ? 'Watch descriptor' : 'Addresses'}
                state={error !== null ? 'error' : 'default'}
                hint={error ?? HELP[kind]}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
