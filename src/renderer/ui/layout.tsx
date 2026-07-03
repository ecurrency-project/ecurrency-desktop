import type { ReactNode } from 'react'
import { MoonIcon, SunIcon } from './icons'

// The window title bar (44px, always visible). Left: an inset reserving the macOS
// traffic-light area (the OS draws the lights via titleBarStyle:hiddenInset, so we
// only leave space). Center: an optional slot (network status when unlocked, app
// name otherwise). Right: the theme toggle. The whole strip is draggable; the
// button opts out. The toggle shows the CURRENT theme's icon (dark→moon).
export function TitleBar({
  theme,
  onToggleTheme,
  left,
  center,
}: {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  left?: ReactNode
  center?: ReactNode
}) {
  return (
    <div className="titlebar">
      <div className="titlebar-inset" />
      {left}
      <div className="titlebar-center">{center}</div>
      <button type="button" className="titlebar-btn" onClick={onToggleTheme} aria-label="Toggle light and dark theme" title="Toggle theme">
        {theme === 'dark' ? <MoonIcon size={18} /> : <SunIcon size={18} />}
      </button>
    </div>
  )
}

// Fills the area under the title bar. `center` vertically/horizontally centers a
// single block (used by Welcome / Done / Unlock); otherwise content is top-aligned
// and scrolls. Position is relative so an absolutely-placed Back button anchors here.
export function Screen({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return <div className={center ? 'screen screen--center' : 'screen'}>{children}</div>
}

export function Title({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <h1 className="ui-title" style={{ fontSize: size }}>
      {children}
    </h1>
  )
}

export function Subtitle({ children }: { children: ReactNode }) {
  return <p className="ui-subtitle">{children}</p>
}
