import { useEffect, useState, type ReactNode } from 'react'
import type { TokenBalance } from '../../shared/protocol'
import { brand } from '../brand'
import { WalletSwitcher } from '../components/WalletSwitcher'
import { wallet } from '../lib/wallet'
import { assetLabelFor } from '../brand/labels'
import { hydrateFromSnapshot, loadWallets, networkLabel, nodeDotColor, refreshAll, useActiveWallet, useBuildNetwork, useNodeStatus } from '../lib/walletData'
import { ActivityIcon, AtomIcon, BoltIcon, ChevDownIcon, CoinsIcon, LockIcon, ReceiveIcon, RefreshIcon, SendIcon, SettingsIcon, Sidebar, WalletIcon, type NavItem } from '../ui'
import { Activity } from './Activity'
import { Coins } from './Coins'
import { Convert } from './Convert'
import { Receive } from './Receive'
import { Send } from './Send'
import { Settings } from './Settings'
import { WalletHome } from './WalletHome'

// The unlocked app shell: a persistent sidebar + a content area that swaps panes.
// Replaces the earlier full-screen-with-back-button model. `preselected` carries
// coins chosen on the Coins pane into the Send pane.
type Nav = 'wallet' | 'send' | 'receive' | 'convert' | 'activity' | 'coins' | 'settings'

const NAV: NavItem[] = [
  { id: 'wallet', label: 'Wallet', icon: <WalletIcon /> },
  { id: 'send', label: 'Send', icon: <SendIcon /> },
  { id: 'receive', label: 'Receive', icon: <ReceiveIcon /> },
  { id: 'activity', label: 'Activity', icon: <ActivityIcon /> },
  { id: 'coins', label: 'Coins', icon: <CoinsIcon /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
]

// The Convert entry appears only when the brand ships an upgrade flow AND main
// confirms it for the active wallet (seed + consensus params) — see below.
const CONVERT_NAV: NavItem = { id: 'convert', label: 'Convert', icon: <BoltIcon /> }

// Header copy per pane. Two subtitles name coins whose tickers are
// per-network (tCOIN, tBTC), so this is a function of the build network
// instead of a constant; mainnet stands in until main reports the network.
function pageMeta(network: 'mainnet' | 'testnet' | null): Record<Nav, { title: string; subtitle: string }> {
  const asset = assetLabelFor(network)
  const source = brand.upgrade?.sourceCoinLabel[network ?? 'mainnet'] ?? 'BTC'
  return {
    wallet: { title: 'Wallet', subtitle: `Your ${brand.assetName} balance and recent activity` },
    send: { title: 'Send', subtitle: `Send ${asset} to any address` },
    receive: { title: 'Receive', subtitle: 'Share your address to get paid' },
    convert: { title: 'Convert', subtitle: `Turn ${source} into ${asset}` },
    activity: { title: 'Activity', subtitle: 'Every transaction on this wallet' },
    coins: { title: 'Coins', subtitle: 'Manage your unspent outputs (UTXOs)' },
    settings: { title: 'Settings', subtitle: 'Manage your wallet and security' },
  }
}

export function WalletShell({ collapsed = false, onShowChangelog }: { collapsed?: boolean; onShowChangelog: () => void }) {
  const [nav, setNav] = useState<Nav>('wallet')
  const [preselected, setPreselected] = useState<readonly string[]>([])
  // The footer's network selector: its label is the BUILD's network as reported
  // by main (testnet tinted orange); the dot carries the live connection status
  // (green/amber/red/grey).
  const netDot = nodeDotColor(useNodeStatus())
  const buildNet = useBuildNetwork()
  const netLabel = networkLabel(buildNet)
  // Which asset the Send pane composes. null = native coin (the sidebar/hero Send,
  // and coin-control); a token when opened from the Tokens panel.
  const [sendToken, setSendToken] = useState<TokenBalance | null>(null)

  // The shell mounts on unlock: paint the last-known snapshot instantly while the
  // live reads refresh in the background.
  useEffect(() => {
    void hydrateFromSnapshot()
    void loadWallets()
  }, [])

  // Convert is double-gated: the brand must ship an upgrade flow (static) and
  // main must confirm it for the active wallet (seed wallets only).
  const [convertEnabled, setConvertEnabled] = useState(false)
  const activeWalletId = useActiveWallet()?.id
  useEffect(() => {
    if (brand.upgrade === null) return
    let alive = true
    wallet
      .upgradeInfo()
      .then((info) => {
        if (alive) setConvertEnabled(info.enabled)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // Re-probe when the active wallet changes: the flow is per wallet (a
    // watch or key wallet has none), and a stale gate left Convert reachable
    // after a switch.
  }, [activeWalletId])

  useEffect(() => {
    setPreselected([])
    setSendToken(null)
  }, [activeWalletId])

  const navItems = convertEnabled ? [...NAV.slice(0, 3), CONVERT_NAV, ...NAV.slice(3)] : NAV
  useEffect(() => {
    if (!convertEnabled && nav === 'convert') setNav('wallet')
  }, [convertEnabled, nav])

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
    case 'convert':
      pane = <Convert />
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
          <span style={{ flex: 1, textAlign: 'left', fontSize: 13, color: buildNet === 'testnet' ? 'var(--warning)' : 'var(--ink-700)', fontWeight: 500 }}>{netLabel}</span>
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
      <button type="button" className="nav-item changelog-link" data-collapsed={collapsed ? 'true' : undefined}
        onClick={onShowChangelog} aria-label={`What’s new · Version ${__APP_VERSION__}`} title={`What’s new · Version ${__APP_VERSION__}`}>
        {collapsed ? <span aria-hidden="true">v</span> : <>What’s new <span className="changelog-link-version">v{__APP_VERSION__}</span></>}
      </button>
    </div>
  )

  const meta = pageMeta(buildNet)[nav]

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <Sidebar items={navItems} active={nav} onNavigate={(id) => go(id as Nav)} footer={footer} collapsed={collapsed} />
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
        <div key={activeWalletId ?? 'none'} style={{ flex: 1, minHeight: 0 }}>
          {pane}
        </div>
      </div>
    </div>
  )
}
