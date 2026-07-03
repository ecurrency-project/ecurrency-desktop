import { useEffect, useState, type ReactNode } from 'react'
import type { TokenBalance } from '../../shared/protocol'
import { brand } from '../brand'
import { WalletSwitcher } from '../components/WalletSwitcher'
import { wallet } from '../lib/wallet'
import { hydrateFromSnapshot, loadWallets, nodeDotColor, refreshAll, useNodeStatus } from '../lib/walletData'
import { ActivityIcon, AtomIcon, ChevDownIcon, CoinsIcon, LockIcon, ReceiveIcon, RefreshIcon, SendIcon, SettingsIcon, Sidebar, WalletIcon, type NavItem } from '../ui'
import { Activity } from './Activity'
import { Coins } from './Coins'
import { Receive } from './Receive'
import { Send } from './Send'
import { Settings } from './Settings'
import { WalletHome } from './WalletHome'

// The unlocked app shell: a persistent sidebar + a content area that swaps panes.
// Replaces the earlier full-screen-with-back-button model. `preselected` carries
// coins chosen on the Coins pane into the Send pane.
type Nav = 'wallet' | 'send' | 'receive' | 'activity' | 'coins' | 'settings'

const NAV: NavItem[] = [
  { id: 'wallet', label: 'Wallet', icon: <WalletIcon /> },
  { id: 'send', label: 'Send', icon: <SendIcon /> },
  { id: 'receive', label: 'Receive', icon: <ReceiveIcon /> },
  { id: 'activity', label: 'Activity', icon: <ActivityIcon /> },
  { id: 'coins', label: 'Coins', icon: <CoinsIcon /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
]

const PAGE_META: Record<Nav, { title: string; subtitle: string }> = {
  wallet: { title: 'Wallet', subtitle: `Your ${brand.assetName} balance and recent activity` },
  send: { title: 'Send', subtitle: `Send ${brand.assetLabel} to any address` },
  receive: { title: 'Receive', subtitle: 'Share your address to get paid' },
  activity: { title: 'Activity', subtitle: 'Every transaction on this wallet' },
  coins: { title: 'Coins', subtitle: 'Manage your unspent outputs (UTXOs)' },
  settings: { title: 'Settings', subtitle: 'Manage your wallet and security' },
}

export function WalletShell({ collapsed = false }: { collapsed?: boolean }) {
  const [nav, setNav] = useState<Nav>('wallet')
  const [preselected, setPreselected] = useState<readonly string[]>([])
  // The footer's network selector: its label is the network name (only mainnet is wired
  // today); the dot carries the live connection status (green/amber/red/grey).
  const netDot = nodeDotColor(useNodeStatus())
  const netLabel = 'Mainnet'
  // Which asset the Send pane composes. null = native coin (the sidebar/hero Send,
  // and coin-control); a token when opened from the Tokens panel.
  const [sendToken, setSendToken] = useState<TokenBalance | null>(null)

  // The shell mounts on unlock: paint the last-known snapshot instantly while the
  // live reads refresh in the background.
  useEffect(() => {
    void hydrateFromSnapshot()
    void loadWallets()
  }, [])

  function go(to: Nav): void {
    // A plain navigation to Send (sidebar or hero) always means a native coin send.
    if (to === 'send') {
      setPreselected([])
      setSendToken(null)
    }
    setNav(to)
  }

  let pane: ReactNode
  switch (nav) {
    case 'send':
      pane = <Send preselected={preselected} token={sendToken} onDone={() => go('wallet')} />
      break
    case 'receive':
      pane = <Receive />
      break
    case 'activity':
      pane = <Activity />
      break
    case 'coins':
      pane = (
        <Coins
          onSendSelected={(outpoints) => {
            setPreselected(outpoints)
            setSendToken(null)
            setNav('send')
          }}
        />
      )
      break
    case 'settings':
      pane = <Settings />
      break
    default:
      pane = (
        <WalletHome
          onSend={() => go('send')}
          onReceive={() => setNav('receive')}
          onSeeAll={() => setNav('activity')}
          onSendToken={(t) => {
            setPreselected([])
            setSendToken(t)
            setNav('send')
          }}
        />
      )
  }

  const footer = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      {/* Network selector — its dot + label mirror the live node status; opens the
          network/connection settings (network switching lives there). */}
      {collapsed ? (
        <button type="button" onClick={() => go('settings')} title={`${netLabel} · network`} style={{ display: 'flex', justifyContent: 'center', padding: '9px 0', background: 'transparent', border: 'none', cursor: 'pointer' }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: netDot, boxShadow: `0 0 0 3px color-mix(in srgb, ${netDot} 24%, transparent)` }} />
        </button>
      ) : (
        <button type="button" onClick={() => go('settings')} title="Network & connection" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: netDot, boxShadow: `0 0 0 3px color-mix(in srgb, ${netDot} 24%, transparent)` }} />
          <span style={{ flex: 1, textAlign: 'left', fontSize: 13, color: 'var(--ink-700)', fontWeight: 500 }}>{netLabel}</span>
          <span style={{ display: 'flex', color: 'var(--ink-500)' }}>
            <ChevDownIcon size={16} />
          </span>
        </button>
      )}
      {/* Post-quantum identity — the wallet signs with Falcon-512 (purple PQ pill). */}
      {collapsed ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '7px 0' }} title="Falcon-512 · post-quantum">
          <span style={{ display: 'flex', color: 'var(--pq)' }}>
            <AtomIcon size={18} />
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 10, background: 'var(--pq-soft)' }} title="This wallet supports Falcon-512 post-quantum signatures">
          <span style={{ display: 'flex', color: 'var(--pq)', flex: 'none' }}>
            <AtomIcon size={16} />
          </span>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--pq)', fontWeight: 600 }}>Falcon-512</span>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--pq)', letterSpacing: '0.04em' }}>PQ</span>
        </div>
      )}
      <button type="button" className="nav-item" data-collapsed={collapsed ? 'true' : undefined} onClick={() => void wallet.lock()} title={collapsed ? 'Lock' : undefined}>
        <span style={{ display: 'flex', width: 20, flex: 'none', justifyContent: 'center' }}>
          <LockIcon size={18} />
        </span>
        {!collapsed && 'Lock'}
      </button>
    </div>
  )

  const meta = PAGE_META[nav]

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <Sidebar items={NAV} active={nav} onNavigate={(id) => go(id as Nav)} footer={footer} collapsed={collapsed} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        <header className="content-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="content-title">{meta.title}</h1>
            <div className="content-subtitle">{meta.subtitle}</div>
          </div>
          <WalletSwitcher />
          <button type="button" className="content-refresh" onClick={() => refreshAll()} title="Refresh">
            <RefreshIcon size={16} />
            Refresh
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0 }}>{pane}</div>
      </div>
    </div>
  )
}
