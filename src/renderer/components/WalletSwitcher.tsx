import { useEffect, useRef, useState } from 'react'
import { resetWalletData, setWallets, useWallets } from '../lib/walletData'
import { wallet } from '../lib/wallet'
import { CheckIcon, ChevDownIcon, EyeIcon, KeyIcon, Pill, PlusIcon, WalletIcon } from '../ui'
import { AddWalletDialog } from './AddWalletDialog'
import { SendFromKeyDialog } from './SendFromKeyDialog'

// Top-bar wallet switcher: the active wallet plus a dropdown of all wallets. Watch
// wallets carry an eye glyph + WATCH badge; imported single keys a key glyph + KEY
// badge. Switching wipes the chain caches and reloads them for the newly active
// wallet.
export function WalletSwitcher() {
  const wallets = useWallets()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [quickSend, setQuickSend] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const active = wallets.find((w) => w.active)
  if (active === undefined) return null

  const choose = async (id: string): Promise<void> => {
    setOpen(false)
    if (busy || id === active.id) return
    setBusy(true)
    try {
      setWallets(await wallet.switchWallet(id))
      resetWalletData()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div ref={ref} style={{ position: 'relative', flex: 'none' }}>
        <button type="button" className="wallet-switch" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} disabled={busy}>
          <span className="wallet-switch-name">{active.label}</span>
          {active.kind === 'watch' && <Pill tone="watch">WATCH</Pill>}
          {active.kind === 'key' && <Pill tone="neutral">KEY</Pill>}
          <ChevDownIcon size={16} />
        </button>
        {open && (
          <div className="wallet-switch-menu" role="menu">
            {wallets.map((w) => (
              <button
                key={w.id}
                type="button"
                role="menuitemradio"
                aria-checked={w.active}
                className="wallet-switch-item"
                onClick={() => void choose(w.id)}
              >
                <span className="wallet-switch-glyph">{w.kind === 'watch' ? <EyeIcon size={16} /> : w.kind === 'key' ? <KeyIcon size={16} /> : <WalletIcon size={16} />}</span>
                <span className="wallet-switch-name" style={{ flex: 1 }}>
                  {w.label}
                </span>
                {w.kind === 'watch' && <Pill tone="watch">WATCH</Pill>}
                {w.kind === 'key' && <Pill tone="neutral">KEY</Pill>}
                {w.active && <CheckIcon size={16} />}
              </button>
            ))}
            <div className="wallet-switch-sep" />
            <button
              type="button"
              className="wallet-switch-item"
              onClick={() => {
                setOpen(false)
                setAdding(true)
              }}
            >
              <span className="wallet-switch-glyph">
                <PlusIcon size={16} />
              </span>
              <span className="wallet-switch-name" style={{ flex: 1 }}>
                Add wallet
              </span>
            </button>
            <button
              type="button"
              className="wallet-switch-item"
              onClick={() => {
                setOpen(false)
                setQuickSend(true)
              }}
            >
              <span className="wallet-switch-glyph">
                <KeyIcon size={16} />
              </span>
              <span className="wallet-switch-name" style={{ flex: 1 }}>
                Send from a key
              </span>
            </button>
          </div>
        )}
      </div>
      <AddWalletDialog open={adding} onClose={() => setAdding(false)} />
      <SendFromKeyDialog open={quickSend} onClose={() => setQuickSend(false)} />
    </>
  )
}
