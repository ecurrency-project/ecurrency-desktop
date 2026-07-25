import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import type { AddressAlgo, ReceiveAddressEntry } from '../../shared/protocol'
import { wallet } from '../lib/wallet'
import { useWallets } from '../lib/walletData'
import { AtomIcon, Button, CheckIcon, CopyIcon, Modal, Pill, PlusIcon, Screen, Segmented } from '../ui'

// Receive screen. The address is derived in main (window.wallet.getReceiveAddress);
// the renderer only displays it and its QR. "New address" advances the HD index so
// each share can use a fresh address (privacy). A key wallet has exactly ONE
// address of one algorithm — main returns it whatever algo is asked — so the
// type toggle and the address controls are hidden, and the post-quantum badge
// is inferred from the address shape (PQ scripthashes are 32 bytes → 52 chars).
export function Receive() {
  const wallets = useWallets()
  const singleKey = wallets.find((w) => w.active)?.kind === 'key'
  const [address, setAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [allOpen, setAllOpen] = useState(false)
  const [all, setAll] = useState<readonly ReceiveAddressEntry[]>([])
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null)
  const [algo, setAlgo] = useState<AddressAlgo>('ecdsa')
  const pq = singleKey ? address !== null && address.length > 40 : algo === 'falcon512'

  useEffect(() => {
    let active = true
    setAddress(null)
    setError(null)
    setCopied(false)
    wallet
      .getReceiveAddress(algo)
      .then((a) => {
        if (active) setAddress(a)
      })
      .catch((e) => {
        if (active) setError((e as Error).message)
      })
    return () => {
      active = false
    }
  }, [algo])

  async function rotate(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      setAddress(await wallet.getNewReceiveAddress(algo))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function copy(): Promise<void> {
    if (address === null) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied; leave the address visible to copy by hand.
    }
  }

  async function openAll(): Promise<void> {
    try {
      setAll(await wallet.listReceiveAddresses(algo))
      setAllOpen(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function copyRow(addr: string): void {
    void navigator.clipboard.writeText(addr)
    setCopiedAddr(addr)
    setTimeout(() => setCopiedAddr((c) => (c === addr ? null : c)), 1500)
  }

  return (
    <Screen>
      <div style={{ maxWidth: 460, width: '100%', margin: '40px auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!singleKey && (
          <Segmented
            ariaLabel="Address type"
            value={algo}
            onChange={setAlgo}
            options={[
              { value: 'ecdsa', label: 'ECDSA' },
              {
                value: 'falcon512',
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <AtomIcon size={14} />
                    Falcon-512
                  </span>
                ),
              },
            ]}
          />
        )}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 18, padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
          {/* Reserve the badge's height in both modes so the QR never jumps. */}
          <div style={{ alignSelf: 'flex-start', visibility: pq ? 'visible' : 'hidden' }}>
            <Pill tone="pq" icon={<AtomIcon size={13} />}>
              Post-quantum address
            </Pill>
          </div>
          {/* QR tile — always on white (scanners want the quiet zone light), so
              on a light theme it needs a border on ALL sides to read as a tile;
              a bottom-only shadow looked like a stray line. */}
          <div style={{ width: 212, height: 212, borderRadius: 14, background: '#fff', padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border-s)' }}>
            {address !== null ? (
              <QRCodeSVG value={address} size={184} bgColor="#ffffff" fgColor="#131311" level="M" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 34, height: 34, borderRadius: '50%', border: '3px solid rgba(20,19,17,0.12)', borderTopColor: '#a32d2d', animation: 'qspin 0.8s linear infinite' }} />
                <span style={{ fontSize: 12, color: '#5f5e5a' }}>{error !== null ? 'Couldn’t load address' : 'Loading address…'}</span>
              </div>
            )}
          </div>

          {/* Address with an inline copy button. */}
          <div style={{ width: '100%', background: 'var(--well)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <code style={{ flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-700)', lineHeight: 1.5, wordBreak: 'break-all' }}>{address ?? '—'}</code>
            <button
              type="button"
              onClick={() => void copy()}
              title="Copy"
              aria-label="Copy address"
              disabled={address === null}
              style={{ flex: 'none', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', borderRadius: 8, cursor: 'pointer', color: copied ? 'var(--success)' : 'var(--ink-500)' }}
            >
              {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
            </button>
          </div>

          <Button fullWidth style={{ height: 46 }} disabled={address === null} onClick={() => void copy()}>
            <CopyIcon size={16} />
            {copied ? 'Copied' : 'Copy address'}
          </Button>

          {/* A key wallet has a single fixed address — nothing to rotate or list. */}
          {!singleKey && (
            <div style={{ display: 'flex', gap: 10, width: '100%' }}>
              <Button variant="secondary" style={{ flex: 1, height: 40 }} disabled={busy} onClick={() => void rotate()}>
                <PlusIcon size={16} />
                {busy ? 'Generating…' : 'New address'}
              </Button>
              <Button variant="secondary" style={{ flex: 1, height: 40 }} onClick={() => void openAll()}>
                All addresses
              </Button>
            </div>
          )}
        </div>

        {singleKey && (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-500)', lineHeight: 1.5, textAlign: 'center' }}>
            This wallet is an imported single key: it has exactly one address.
          </p>
        )}
        {!singleKey && algo === 'falcon512' && (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-500)', lineHeight: 1.5, textAlign: 'center' }}>
            Falcon-512 addresses use post-quantum-safe signatures. Both address types receive to the same wallet.
          </p>
        )}

        {error !== null && address !== null && (
          <div className="field-hint field-hint--error" style={{ textAlign: 'center' }}>
            {error}
          </div>
        )}

        <Modal open={allOpen} onClose={() => setAllOpen(false)} title="Your addresses" subtitle="Copy any address, or show one here." width={460}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 8, maxHeight: 380, overflow: 'auto' }}>
            {all.map((a) => {
              const showing = a.address === address
              return (
                <div key={a.address} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '6px 10px', borderRadius: 8 }}>
                  <span style={{ flex: 'none', width: 26, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-300)' }}>#{a.index}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontFamily: 'var(--mono)', color: 'var(--ink-700)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.address}</span>
                  <button
                    type="button"
                    aria-label="Copy address"
                    title="Copy"
                    onClick={() => copyRow(a.address)}
                    style={{ flex: 'none', width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', borderRadius: 7, color: copiedAddr === a.address ? 'var(--success)' : 'var(--ink-500)', cursor: 'pointer' }}
                  >
                    {copiedAddr === a.address ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
                  </button>
                  {showing ? (
                    <Pill tone="success">Showing</Pill>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setAddress(a.address)
                        setCopied(false)
                      }}
                    >
                      Show
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        </Modal>
      </div>
    </Screen>
  )
}
