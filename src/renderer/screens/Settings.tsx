import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Contact, NodeKind, NodeSettings, WalletInfo } from '../../shared/protocol'
import { brand } from '../brand'
import { AddWalletDialog } from '../components/AddWalletDialog'
import { setAdvancedMode, useAdvancedMode } from '../lib/prefs'
import { wallet } from '../lib/wallet'
import { nodeDotColor, nodeSyncPercent, pollNode, probeNode, resetWalletData, setContacts as cacheSetContacts, setWallets, useActiveWallet, useAddressPlaceholder, useContacts, useNodeStatus, useWallets, type NodeStatusSnapshot } from '../lib/walletData'
import { BoltIcon, Button, ContactDialog, EyeIcon, GlobeIcon, KeyIcon, Modal, OnionIcon, PasswordField, PasswordStrength, PencilIcon, Pill, PlusIcon, RetryIcon, Screen, Segmented, ServerIcon, ShieldIcon, Switch, TextArea, TextField, TrashIcon, WalletIcon } from '../ui'

// Settings: network status, security (reveal recovery phrase behind a password
// re-auth, change password — both in modals), and contacts. Every key operation
// runs in main; the renderer only collects input and shows results. Each section
// is a single card with a header and divided rows, matching the design.
export function Settings() {
  return (
    <Screen>
      <div style={{ padding: 40, maxWidth: 560, width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <AccountsCard />
        <NetworkCard />
        <SecurityCard />
        <WatchCard />
        <ContactsCard />
        <PreferencesCard />
      </div>
    </Screen>
  )
}

function SectionCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px' }}>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--ink-500)' }}>{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

function Row({ title, detail, detailTone, action }: { title: string; detail: ReactNode; detailTone?: 'warning'; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-900)' }}>{title}</div>
        <div style={{ fontSize: 12, color: detailTone === 'warning' ? 'var(--warning)' : 'var(--ink-500)', marginTop: 2 }}>{detail}</div>
      </div>
      {action}
    </div>
  )
}

// Host portion of a URL for compact display; falls back to the raw string.
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// The node the wallet talks to: a Public slot (bundled Esplora REST), the user's own
// Esplora REST node, or Electrum (not wired yet). The live status row, title bar and
// sidebar all read the shared node-status store; Tor and the network switch are
// placeholders for now.
function NetworkCard() {
  const [settings, setSettings] = useState<NodeSettings | null>(null)
  const [editing, setEditing] = useState(false)
  const [addingCustom, setAddingCustom] = useState(false)
  const node = useNodeStatus()

  useEffect(() => {
    void wallet
      .getNode()
      .then(setSettings)
      .catch(() => {})
    void pollNode()
  }, [])

  // After any node change: adopt the new settings, refetch chain data, and re-probe the
  // node with a loader (the fresh endpoint may answer slowly).
  const applySettings = (s: NodeSettings): void => {
    setSettings(s)
    resetWalletData()
    void probeNode()
  }

  async function choose(kind: NodeKind, url?: string): Promise<void> {
    if (settings === null) return
    if (kind === settings.selected && (kind !== 'custom' || url === settings.selectedCustomUrl)) return
    if (kind === 'own' && settings.ownUrl === undefined) {
      setEditing(true)
      return
    }
    try {
      applySettings(await wallet.selectNode(kind, url))
    } catch {
      // e.g. Electrum not available yet — ignore.
    }
  }

  async function removeCustom(url: string): Promise<void> {
    try {
      applySettings(await wallet.removeCustomNode(url))
    } catch {
      // Removal only touches local config; a failure here is transient.
    }
  }

  const selected = settings?.selected ?? 'public'
  return (
    <SectionCard title="Network & connection">
      <NodeSlot icon={<GlobeIcon size={18} />} name="Public node" detail={settings !== null && settings !== undefined ? `${hostOf(settings.publicUrl)} · Esplora REST` : '…'} selected={selected === 'public'} onSelect={() => void choose('public')} />
      <NodeSlot
        icon={<ServerIcon size={18} />}
        name="Your own node"
        detail={settings?.ownUrl !== undefined ? `${hostOf(settings.ownUrl)} · REST${settings.hasAuth ? ' · auth' : ''}` : 'Not set · REST'}
        selected={selected === 'own'}
        onSelect={() => void choose('own')}
        action={
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <PencilIcon size={14} />
            Edit
          </Button>
        }
      />
      {/* Community-hosted public esplora instances the user added. They join
          the failover pool; the radio makes one of them primary. */}
      {(settings?.customNodes ?? []).map((c) => (
        <NodeSlot
          key={c.url}
          icon={<GlobeIcon size={18} />}
          name={c.name ?? hostOf(c.url)}
          detail={`${hostOf(c.url)} · Esplora REST · added by you`}
          selected={selected === 'custom' && settings?.selectedCustomUrl === c.url}
          onSelect={() => void choose('custom', c.url)}
          action={
            <Button variant="secondary" size="sm" onClick={() => void removeCustom(c.url)} aria-label={`Remove ${c.name ?? hostOf(c.url)}`}>
              <TrashIcon size={14} />
            </Button>
          }
        />
      ))}
      <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border)' }}>
        <Button variant="secondary" size="sm" onClick={() => setAddingCustom(true)}>
          <PlusIcon size={14} />
          Add public node
        </Button>
      </div>
      <NodeSlot icon={<BoltIcon size={18} />} name="Electrum server" detail="Coming soon · SSL" disabled />
      <NodeStatusRow snap={node} onRetry={() => void probeNode()} />
      <TorRow />
      <NetworkRow network={settings?.network} />
      <NetworkFootnote />
      <EditOwnNodeModal open={editing} settings={settings} onClose={() => setEditing(false)} onChanged={applySettings} />
      <AddCustomNodeModal open={addingCustom} onClose={() => setAddingCustom(false)} onChanged={applySettings} />
    </SectionCard>
  )
}

// Add a community public node: an Esplora REST base URL and an optional label.
// The URL is probed by main before it is saved (reachability + right chain);
// there is no protocol choice — the wallet speaks Esplora only — and no
// credentials (auth belongs to the own-node slot).
function AddCustomNodeModal({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: (s: NodeSettings) => void }) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = (): void => {
    setUrl('')
    setName('')
    setError(null)
    onClose()
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await wallet.addCustomNode(url.trim(), name.trim() === '' ? undefined : name.trim()))
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) close()
      }}
      title="Add a public node"
      subtitle="A community-hosted Esplora REST endpoint. It is checked before being added and joins the failover list."
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy || url.trim() === ''} onClick={() => void submit()}>
            {busy ? 'Checking…' : 'Check & add'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <TextField label="Node URL" mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://node.example.org" aria-label="Public node URL" />
        <TextField label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="Community node" aria-label="Node name" />
        {error !== null && <div className="field-hint field-hint--error">{error}</div>}
      </div>
    </Modal>
  )
}

// A filled radio dot — accent ring + dot when active.
function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden="true" style={{ flex: 'none', width: 18, height: 18, borderRadius: '50%', border: `2px solid ${checked ? 'var(--primary)' : 'var(--border-s)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {checked && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--primary)' }} />}
    </span>
  )
}

// One selectable backend row (radio + icon + name/detail + optional action).
function NodeSlot({ icon, name, detail, selected = false, disabled = false, onSelect, action }: { icon: ReactNode; name: string; detail: string; selected?: boolean; disabled?: boolean; onSelect?: () => void; action?: ReactNode }) {
  const interactive = onSelect !== undefined && !disabled
  return (
    <div
      role={onSelect !== undefined ? 'radio' : undefined}
      aria-checked={onSelect !== undefined ? selected : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onSelect : undefined}
      onKeyDown={(e) => {
        if (interactive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onSelect?.()
        }
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderTop: '1px solid var(--border)', cursor: interactive ? 'pointer' : 'default', opacity: disabled ? 0.5 : 1, background: selected ? 'var(--red-soft)' : 'transparent' }}
    >
      <RadioDot checked={selected} />
      <span style={{ display: 'flex', color: selected ? 'var(--primary)' : 'var(--ink-500)' }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-900)' }}>{name}</div>
        <div style={{ fontSize: 12.5, fontFamily: 'var(--mono)', color: 'var(--ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail}</div>
      </div>
      {action}
    </div>
  )
}

// Live connection indicator: a loader while re-probing, then "Connected · block N · NN ms",
// "Syncing NN%" with a progress bar, or "Offline".
function NodeStatusRow({ snap, onRetry }: { snap: NodeStatusSnapshot; onRetry: () => void }) {
  const { status, checking } = snap
  // Re-probe in progress (after a node change), or first load — show a loader, not a
  // stale value.
  if (checking || status === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
        <span className="spinner spinner--xs" aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 500, color: 'var(--ink-500)' }}>Checking node…</div>
      </div>
    )
  }
  const reachable = status.reachable === true
  const syncing = status.syncing === true
  const dot = nodeDotColor(snap)
  const pct = nodeSyncPercent(snap)
  let line: string
  if (!reachable) {
    line = 'Offline — node unreachable'
  } else {
    const parts = [syncing ? (pct !== null ? `Syncing ${String(pct)}%` : 'Syncing') : 'Connected']
    if (status.blockHeight !== undefined && status.blockHeight >= 0) parts.push(`block ${status.blockHeight.toLocaleString('en-US')}`)
    if (status.latencyMs !== undefined) parts.push(`${String(status.latencyMs)} ms`)
    line = parts.join(' · ')
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
      <span aria-hidden="true" style={{ width: 9, height: 9, flex: 'none', borderRadius: '50%', background: dot, boxShadow: `0 0 0 3px color-mix(in srgb, ${dot} 22%, transparent)` }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-900)' }}>{line}</div>
        {status.url !== '' && <div style={{ fontSize: 12, color: 'var(--ink-500)', fontFamily: 'var(--mono)' }}>{hostOf(status.url)}</div>}
        {syncing && pct !== null && (
          <div style={{ height: 3, borderRadius: 2, background: 'var(--well)', overflow: 'hidden', marginTop: 8 }}>
            <div style={{ height: '100%', width: `${String(pct)}%`, background: 'var(--warning)', borderRadius: 2, transition: 'width .4s ease' }} />
          </div>
        )}
      </div>
      {!reachable && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RetryIcon size={14} />
          Retry
        </Button>
      )}
    </div>
  )
}

// Tor toggle — placeholder until routing lands (#89); the switch is disabled.
function TorRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 18px', borderTop: '1px solid var(--border)', opacity: 0.55 }}>
      <span style={{ display: 'flex', color: 'var(--ink-500)' }}>
        <OnionIcon size={18} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-900)', display: 'flex', alignItems: 'center', gap: 8 }}>
          Route all traffic through Tor <Pill tone="neutral">Soon</Pill>
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 2 }}>Hides your IP from the server. Slower.</div>
      </div>
      <Switch checked={false} onChange={() => {}} disabled label="Route all traffic through Tor" />
    </div>
  )
}

// Network switch. The network is a per-process profile: choosing the other
// chain persists the choice and RESTARTS the app (a session is never
// multi-network). Each network keeps its own wallets/settings on disk;
// nothing is deleted by switching. Custom stays for a future regtest profile.
function NetworkRow({ network }: { network?: 'mainnet' | 'testnet' }) {
  const [target, setTarget] = useState<'mainnet' | 'testnet' | null>(null)
  const [switching, setSwitching] = useState(false)

  const confirmSwitch = (): void => {
    if (target === null) return
    setSwitching(true)
    // Fire-and-forget: main writes the profile and relaunches the app.
    void wallet.setNetwork(target).catch(() => setSwitching(false))
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-900)' }}>Network</div>
        <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 2 }}>Switching restarts the app; each network keeps its own wallets</div>
      </div>
      <Segmented<'mainnet' | 'testnet' | 'custom'>
        ariaLabel="Network"
        value={network ?? 'mainnet'}
        onChange={(v) => {
          if (v !== 'custom' && network !== undefined && v !== network) setTarget(v)
        }}
        options={[
          { value: 'mainnet', label: 'Mainnet' },
          { value: 'testnet', label: 'Testnet' },
          { value: 'custom', label: 'Custom', disabled: true },
        ]}
      />
      <Modal
        open={target !== null}
        onClose={() => {
          if (!switching) setTarget(null)
        }}
        title={`Switch to ${target === 'testnet' ? 'Testnet' : 'Mainnet'}?`}
        subtitle="The app will restart on the selected network."
        footer={
          <>
            <Button variant="secondary" disabled={switching} onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button disabled={switching} onClick={confirmSwitch}>
              {switching ? 'Restarting…' : 'Switch & restart'}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-700)', lineHeight: 1.55 }}>
          Wallets, contacts and node settings are kept separately per network. Nothing is
          deleted: everything from the current network stays on this computer and reappears
          when you switch back.
        </p>
      </Modal>
    </div>
  )
}

function NetworkFootnote() {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
      <span style={{ display: 'flex', color: 'var(--ink-300)', flex: 'none', marginTop: 1 }}>
        <ShieldIcon size={15} />
      </span>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-500)', lineHeight: 1.5 }}>Using your own node or Electrum — optionally over Tor — means you don&apos;t reveal your addresses or IP to a third-party server.</p>
    </div>
  )
}

// Set or change the user's own-node URL. The node is probed (and its network checked)
// before switching; "Remove" drops it and falls back to the public node.
function EditOwnNodeModal({ open, settings, onClose, onChanged }: { open: boolean; settings: NodeSettings | null; onClose: () => void; onChanged: (s: NodeSettings) => void }) {
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasOwn = settings?.ownUrl !== undefined
  const hasAuth = settings?.hasAuth === true

  useEffect(() => {
    if (!open) return
    setUrl(settings?.ownUrl ?? '')
    setUser(settings?.authUser ?? '')
    setPassword('')
    setError(null)
    setBusy(false)
  }, [open, settings])

  async function save(): Promise<void> {
    if (busy || url.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      // Blank password keeps any saved credential (it's never shown here); a value replaces it.
      onChanged(await wallet.setOwnNode(url.trim(), user.trim() === '' ? undefined : user.trim(), password === '' ? undefined : password))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach that node.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      onChanged(await wallet.clearOwnNode())
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the node.')
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      {hasOwn ? (
        <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={() => void remove()}>
          Remove
        </Button>
      ) : (
        <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      )}
      <Button style={{ flex: 1 }} disabled={busy || url.trim() === ''} onClick={() => void save()}>
        {busy ? 'Connecting…' : 'Save'}
      </Button>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title="Your own node" subtitle={`Point the wallet at your own Esplora REST node (e.g. a local ${brand.assetName} node)`} width={460} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 4 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-500)', lineHeight: 1.5 }}>The node is checked before switching. Your node fully replaces the public one — no fallback. Enable the REST API on your node (port {brand.nodeRestPort}).</p>
        <TextField label="Node URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`http://127.0.0.1:${String(brand.nodeRestPort)}`} aria-label="Node URL" mono />
        <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />
        <p style={{ margin: 0, fontSize: 12, color: 'var(--ink-500)', lineHeight: 1.5 }}>Optional — only if your node sits behind HTTP Basic auth (e.g. a reverse proxy). The password is stored encrypted.</p>
        <TextField label="Username" value={user} onChange={(e) => setUser(e.target.value)} placeholder="Optional" aria-label="Node username" autoComplete="off" />
        <PasswordField label="Password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={hasAuth ? 'Saved — leave blank to keep' : 'Optional'} aria-label="Node password" />
        {error !== null && <div className="field-hint field-hint--error">{error}</div>}
      </div>
    </Modal>
  )
}

// Display preferences. "Advanced mode" reveals Sparrow-style technical detail in
// the transaction drawer (scripts, signatures, outpoints, raw hex); off by default.
function PreferencesCard() {
  const advanced = useAdvancedMode()
  return (
    <SectionCard title="Preferences">
      <Row
        title="Advanced mode"
        detail="Show technical transaction details — scripts, signatures, outpoints and raw hex — in the transaction view."
        action={<Switch checked={advanced} onChange={setAdvancedMode} label="Advanced mode" />}
      />
    </SectionCard>
  )
}

function SecurityCard() {
  const [revealOpen, setRevealOpen] = useState(false)
  const [changeOpen, setChangeOpen] = useState(false)
  return (
    <SectionCard title="Security">
      <Row
        title="Recovery phrase"
        detail="Revealing requires your password. Never share it."
        detailTone="warning"
        action={
          <Button variant="secondary" size="sm" onClick={() => setRevealOpen(true)}>
            Reveal
          </Button>
        }
      />
      <Row
        title="Change password"
        detail="Update the password that unlocks this device."
        action={
          <Button variant="secondary" size="sm" onClick={() => setChangeOpen(true)}>
            Change
          </Button>
        }
      />
      <RevealPhraseModal open={revealOpen} onClose={() => setRevealOpen(false)} />
      <ChangePasswordModal open={changeOpen} onClose={() => setChangeOpen(false)} />
    </SectionCard>
  )
}

function RevealPhraseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [words, setWords] = useState<readonly string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const shown = words.length > 0

  useEffect(() => {
    if (open) {
      setPw('')
      setWords([])
      setError(null)
      setBusy(false)
    }
  }, [open])

  async function reveal(): Promise<void> {
    if (busy || pw.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const phrase = await wallet.revealMnemonic(pw)
      setWords(phrase.split(' '))
      setPw('')
    } catch {
      setError('Incorrect password — try again.')
      setPw('')
    } finally {
      setBusy(false)
    }
  }

  const footer = shown ? (
    <Button fullWidth onClick={onClose}>
      Done
    </Button>
  ) : (
    <>
      <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button style={{ flex: 1 }} disabled={busy || pw.length === 0} onClick={() => void reveal()}>
        {busy ? 'Checking…' : 'Reveal'}
      </Button>
    </>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reveal recovery phrase"
      icon={
        <span style={{ display: 'flex', color: 'var(--ink-500)' }}>
          <KeyIcon size={16} />
        </span>
      }
      width={440}
      footer={footer}
    >
      {shown ? (
        <div style={{ paddingBottom: 4 }}>
          <Pill tone="warning" icon={<ShieldIcon size={14} />}>
            Don&apos;t share this with anyone
          </Pill>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
            {words.map((w, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--well)' }}>
                <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-300)' }}>{i + 1}</span>
                <span style={{ fontSize: 13.5, fontFamily: 'var(--mono)', fontWeight: 500, color: 'var(--ink-900)' }}>{w}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ paddingBottom: 4 }}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink-500)', lineHeight: 1.5 }}>Enter your password to reveal your 12-word phrase. Make sure no one is watching your screen.</p>
          <PasswordField value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" aria-label="Password" />
          {error !== null && <div className="field-hint field-hint--error">{error}</div>}
        </div>
      )}
    </Modal>
  )
}

function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const valid = current.length > 0 && next.length >= 8 && next === confirm

  useEffect(() => {
    if (open) {
      setCurrent('')
      setNext('')
      setConfirm('')
      setError(null)
      setBusy(false)
    }
  }, [open])

  async function submit(): Promise<void> {
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    try {
      await wallet.changePassword(current, next)
      onClose()
    } catch (e) {
      const m = (e as Error).message
      setError(m === '' ? 'Could not change the password.' : m)
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button style={{ flex: 1 }} disabled={busy || !valid} onClick={() => void submit()}>
        {busy ? 'Saving…' : 'Update password'}
      </Button>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title="Change password" width={420} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 4 }}>
        <PasswordField label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" aria-label="Current password" />
        <div>
          <PasswordField label="New password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 8 characters" aria-label="New password" />
          {next.length > 0 && <PasswordStrength password={next} />}
        </div>
        <PasswordField label="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter new password" aria-label="Confirm new password" />
        {confirm.length > 0 && next !== confirm && <div className="field-hint field-hint--error">Passwords don&apos;t match yet.</div>}
        {error !== null && <div className="field-hint field-hint--error">{error}</div>}
      </div>
    </Modal>
  )
}

// Export the active (seed) wallet's watch descriptor. Hidden for watch wallets
// (no keys to derive from) AND for key wallets (a single fixed address has no
// derivation to describe — follow it as a watch-only address list instead).
function WatchCard() {
  const active = useActiveWallet()
  const [open, setOpen] = useState(false)
  if (active === undefined || active.kind !== 'seed') return null
  return (
    <SectionCard title="Watch-only">
      <Row
        title="Export watch descriptor"
        detail="Share this wallet's public addresses to follow it on another device — no keys ever leave here."
        action={
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Export
          </Button>
        }
      />
      <ExportDescriptorModal open={open} onClose={() => setOpen(false)} />
    </SectionCard>
  )
}

function ExportDescriptorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    setText('')
    setError(null)
    setCopied(false)
    setBusy(true)
    void wallet
      .exportWatchDescriptor()
      .then(setText)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not export the descriptor.'))
      .finally(() => setBusy(false))
  }, [open])

  function copy(): void {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const footer = (
    <>
      <Button variant="secondary" style={{ flex: 1 }} onClick={onClose}>
        Close
      </Button>
      <Button style={{ flex: 1 }} disabled={busy || text === ''} onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title="Watch descriptor" subtitle="Paste this into “Add wallet → Descriptor” on another device" width={460} footer={footer}>
      <div style={{ paddingBottom: 4 }}>
        {busy ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 2px', fontSize: 13, color: 'var(--ink-500)' }}>
            <span className="spinner spinner--xs" aria-hidden="true" /> Building descriptor…
          </div>
        ) : error !== null ? (
          <div className="field-hint field-hint--error">{error}</div>
        ) : (
          <TextArea mono readOnly rows={5} value={text} aria-label="Watch descriptor" />
        )}
      </div>
    </Modal>
  )
}

const shortAddr = (a: string): string => (a.length > 16 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a)

const iconBtn: CSSProperties = {
  flex: 'none',
  width: 34,
  height: 34,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--border-s)',
  background: 'transparent',
  borderRadius: 9,
  color: 'var(--ink-500)',
  cursor: 'pointer',
}

// All wallets. Switching is in the top-bar switcher; here you add watch-only wallets
// and rename/remove them. The seed wallet is listed but can't be removed (it holds
// the key that seals every wallet's data).
function AccountsCard() {
  const wallets = useWallets()
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<WalletInfo | null>(null)
  const [removing, setRemoving] = useState<WalletInfo | null>(null)
  return (
    <SectionCard
      title="Accounts"
      action={
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
          <PlusIcon size={14} />
          Add wallet
        </Button>
      }
    >
      {wallets.map((w) => (
        <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderTop: '1px solid var(--border)' }}>
          <span
            style={{
              width: 36,
              height: 36,
              flex: 'none',
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: w.kind === 'watch' ? 'var(--well)' : 'var(--red-soft)',
              color: w.kind === 'watch' ? 'var(--ink-700)' : 'var(--primary)',
            }}
          >
            {w.kind === 'watch' ? <EyeIcon size={18} /> : w.kind === 'key' ? <KeyIcon size={18} /> : <WalletIcon size={18} />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-900)' }}>{w.label}</div>
            {w.address !== undefined && <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--ink-500)' }}>{shortAddr(w.address)}</div>}
          </div>
          {w.kind === 'watch' && (
            <Pill tone="watch" icon={<EyeIcon size={12} />}>
              Watch-only
            </Pill>
          )}
          {w.kind === 'key' && (
            <Pill tone="neutral" icon={<KeyIcon size={12} />}>
              Single key
            </Pill>
          )}
          {w.removable && (
            <>
              <button type="button" aria-label="Rename wallet" title="Rename" onClick={() => setRenaming(w)} style={iconBtn}>
                <PencilIcon size={15} />
              </button>
              <button type="button" aria-label="Remove wallet" title="Remove" onClick={() => setRemoving(w)} style={{ ...iconBtn, color: 'var(--danger)' }}>
                <TrashIcon size={15} />
              </button>
            </>
          )}
        </div>
      ))}
      <AddWalletDialog open={adding} onClose={() => setAdding(false)} />
      <RenameWalletModal target={renaming} onClose={() => setRenaming(null)} />
      <RemoveWalletModal target={removing} onClose={() => setRemoving(null)} />
    </SectionCard>
  )
}

function RenameWalletModal({ target, onClose }: { target: WalletInfo | null; onClose: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (target !== null) setName(target.label)
  }, [target])

  async function save(): Promise<void> {
    if (target === null || name.trim() === '') return
    setBusy(true)
    try {
      setWallets(await wallet.renameWallet(target.id, name.trim()))
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button style={{ flex: 1 }} disabled={busy || name.trim() === ''} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
    </>
  )

  return (
    <Modal open={target !== null} onClose={onClose} title="Rename wallet" width={400} footer={footer}>
      <div style={{ paddingBottom: 4 }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Wallet name" />
      </div>
    </Modal>
  )
}

function RemoveWalletModal({ target, onClose }: { target: WalletInfo | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove(): Promise<void> {
    if (target === null) return
    setBusy(true)
    setError(null)
    try {
      const wasActive = target.active
      setWallets(await wallet.removeWallet(target.id))
      // Removing the active wallet reassigns it in main — reload chain data for the new one.
      if (wasActive) resetWalletData()
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
      <Button style={{ flex: 1 }} disabled={busy} onClick={() => void remove()}>
        {busy ? 'Removing…' : 'Remove'}
      </Button>
    </>
  )

  const title = target?.kind === 'seed' ? 'Remove wallet' : target?.kind === 'key' ? 'Remove key wallet' : 'Remove watch wallet'
  // Seed and key wallets hold signing material — deleting them without a backup
  // loses access to the funds, so both get the warning tone and wording.
  const holdsKeys = target?.kind === 'seed' || target?.kind === 'key'
  return (
    <Modal open={target !== null} onClose={onClose} title={title} width={420} footer={footer}>
      <div style={{ paddingBottom: 4 }}>
        <p style={{ margin: 0, fontSize: 13.5, color: holdsKeys ? 'var(--warning)' : 'var(--ink-700)', lineHeight: 1.5 }}>
          {target?.kind === 'seed'
            ? `“${target.label}” and its stored seed will be deleted from this device. Make sure you have its recovery phrase — it's the only way to restore it.`
            : target?.kind === 'key'
              ? `“${target.label}” and its stored private key will be deleted from this device. Make sure you have a backup of the key — your recovery phrase does NOT restore it.`
              : `“${target?.label ?? ''}” will be removed and its cached data deleted. It has no keys, so you can add it again from its source at any time.`}
        </p>
        {error !== null && (
          <div className="field-hint field-hint--error" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}

type Dialog = { mode: 'add' } | { mode: 'edit'; contact: Contact }

function ContactsCard() {
  // The address book is shared state: Send reads it through the same cache.
  // Editing here must publish the new list, or Send keeps offering a contact
  // that no longer exists until the window is reloaded.
  // Add/edit/delete errors surface inside ContactDialog (onSubmit may throw);
  // the only error owned here is the cache's load failure.
  const { data: contacts, error: loadError } = useContacts()
  const setContacts = cacheSetContacts
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const addressHint = useAddressPlaceholder()

  const list = contacts ?? []
  const editing = dialog?.mode === 'edit' ? dialog.contact : null

  return (
    <SectionCard
      title="Contacts"
      action={
        <Button variant="secondary" size="sm" onClick={() => setDialog({ mode: 'add' })}>
          <PlusIcon size={14} />
          Add contact
        </Button>
      }
    >
      {list.length === 0 ? (
        <div style={{ padding: '22px 18px', textAlign: 'center', fontSize: 13, color: 'var(--ink-500)', borderTop: '1px solid var(--border)' }}>No contacts.</div>
      ) : (
        list.map((c) => (
          <div key={c.address} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderTop: '1px solid var(--border)' }}>
            <span style={{ width: 34, height: 34, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--red-soft)', color: 'var(--primary)', fontSize: 14, fontWeight: 700 }}>{c.name.slice(0, 1).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-900)' }}>{c.name}</div>
              <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.address}</div>
            </div>
            <button
              type="button"
              onClick={() => setDialog({ mode: 'edit', contact: c })}
              title="Edit"
              aria-label="Edit contact"
              style={{ flex: 'none', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border-s)', background: 'transparent', borderRadius: 9, color: 'var(--ink-500)', cursor: 'pointer' }}
            >
              <PencilIcon size={15} />
            </button>
          </div>
        ))
      )}
      {loadError !== undefined && (
        <div className="field-hint field-hint--error" style={{ padding: '0 18px 12px' }}>
          {loadError.message}
        </div>
      )}

      <ContactDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        addressPlaceholder={addressHint}
        title={editing !== null ? 'Edit contact' : 'Add contact'}
        initialName={editing?.name ?? ''}
        initialAddress={editing?.address ?? ''}
        onSubmit={async (name, address) => {
          // Contacts are keyed by address: addContact also renames an existing one.
          // If the address itself changed during an edit, drop the old entry first.
          if (editing !== null && editing.address !== address) {
            await wallet.removeContact(editing.address)
          }
          setContacts(await wallet.addContact(name, address))
        }}
        onDelete={
          editing !== null
            ? async () => {
                setContacts(await wallet.removeContact(editing.address))
              }
            : undefined
        }
      />
    </SectionCard>
  )
}
