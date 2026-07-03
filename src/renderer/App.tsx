import { useEffect, useState, type ReactNode } from 'react'
import type { VaultStatus } from '../shared/protocol'
import { startActivityReporting } from './lib/activity'
import { wallet } from './lib/wallet'
import { nodeDotColor, useNodeStatus } from './lib/walletData'
import { brand } from './brand'
import { ChevLeftIcon, ChevRightIcon, TitleBar } from './ui'
import { UpdateBanner } from './components/UpdateBanner'
import { Onboarding } from './screens/Onboarding'
import { Unlock } from './screens/Unlock'
import { WalletShell } from './screens/WalletShell'

// Top-level router. The main-process Vault is the source of truth; the renderer
// reflects its status: empty → Onboarding, locked → Unlock, unlocked → WalletHome.
//
// We read the status once on mount and subscribe to pushed changes ONLY to catch
// an external lock (autolock timeout in main) and return to the lock screen. We do
// NOT auto-route on 'unlocked'/'empty': those happen as a side effect of
// create()/unlock() mid-flow, and routing on them would skip the onboarding
// "Done" screen — so those transitions are driven by explicit callbacks.
type Route = 'boot' | 'onboarding' | 'unlock' | 'wallet'

function routeForStatus(status: VaultStatus): Route {
  return status === 'unlocked' ? 'wallet' : status === 'locked' ? 'unlock' : 'onboarding'
}

export function App() {
  const [route, setRoute] = useState<Route>('boot')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [collapsed, setCollapsed] = useState(false)
  const node = useNodeStatus()

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'light') root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
  }, [theme])

  useEffect(() => {
    let active = true
    wallet
      .getStatus()
      .then((status) => {
        if (active) setRoute(routeForStatus(status))
      })
      .catch(() => {
        if (active) setRoute('onboarding')
      })
    const unsubscribe = wallet.onStatusChanged((status) => {
      if (active && status === 'locked') setRoute('unlock')
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // The OS window title comes from the brand config; index.html stays neutral.
  useEffect(() => {
    document.title = brand.productName
  }, [])

  // Drive the main-process idle-autolock from REAL user interaction only. The
  // background SWR poll touches the master key every 30s, which main no longer
  // counts as activity — so without this the timer would still fire correctly,
  // and with it an actively-used wallet stays unlocked. Mounted only while
  // unlocked; the cleanup detaches on lock/unmount.
  useEffect(() => {
    if (route !== 'wallet') return
    return startActivityReporting()
  }, [route])

  let screen: ReactNode = null
  switch (route) {
    case 'wallet':
      screen = <WalletShell collapsed={collapsed} />
      break
    case 'unlock':
      screen = <Unlock onUnlocked={() => setRoute('wallet')} />
      break
    case 'onboarding':
      screen = <Onboarding onComplete={() => setRoute('wallet')} />
      break
    default:
      screen = null
  }

  const left: ReactNode =
    route === 'wallet' ? (
      <button type="button" className="titlebar-btn" onClick={() => setCollapsed((c) => !c)} aria-label="Toggle sidebar" title="Toggle sidebar">
        {collapsed ? <ChevRightIcon size={18} /> : <ChevLeftIcon size={18} />}
      </button>
    ) : null

  // Title-bar connection chip: the dot mirrors the shared node status (green connected,
  // amber syncing, red offline, grey while checking/unknown) so an offline node doesn't
  // read as healthy here.
  const netLabel = node.status === null || node.checking ? 'Mainnet' : node.status.reachable !== true ? 'Offline' : node.status.syncing ? 'Syncing' : 'Mainnet'
  const center: ReactNode =
    route === 'wallet' ? (
      <span className="titlebar-net">
        <span className="titlebar-net-dot" style={{ background: nodeDotColor(node) }} />
        {netLabel}
      </span>
    ) : route === 'boot' ? null : (
      <span className="titlebar-name">{brand.productName}</span>
    )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TitleBar left={left} theme={theme} onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))} center={center} />
      <UpdateBanner />
      <div style={{ flex: 1, minHeight: 0 }}>{screen}</div>
    </div>
  )
}
