import type { ReactNode } from 'react'
import { brand } from '../brand'
import { Logo } from '../brand/Logo'

export interface NavItem {
  readonly id: string
  readonly label: string
  readonly icon?: ReactNode
}

// The wallet's primary navigation, sized to the design (248px, brand + subtitle,
// icon + label rows; the active item's left bar comes from the .nav-item CSS).
// Presentational: the shell owns active state, navigation, and the footer.
export function Sidebar({
  items,
  active,
  onNavigate,
  footer,
  collapsed = false,
}: {
  items: readonly NavItem[]
  active: string
  onNavigate: (id: string) => void
  footer?: ReactNode
  collapsed?: boolean
}) {
  return (
    <nav
      aria-label="Primary"
      style={{
        width: collapsed ? 76 : 248,
        flex: 'none',
        height: '100%',
        background: 'var(--sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 12px',
        gap: 3,
        overflow: 'hidden',
        transition: 'width 0.18s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start', gap: 11, padding: '4px 8px 16px' }}>
        <Logo size={26} />
        {!collapsed && (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-900)', letterSpacing: '-0.01em', lineHeight: 1.1 }}>{brand.assetName}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 2 }}>Wallet</div>
          </div>
        )}
      </div>

      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="nav-item"
          data-active={item.id === active ? 'true' : undefined}
          data-collapsed={collapsed ? 'true' : undefined}
          aria-current={item.id === active ? 'page' : undefined}
          title={collapsed ? item.label : undefined}
          onClick={() => onNavigate(item.id)}
        >
          <span style={{ display: 'flex', width: 20, flex: 'none', justifyContent: 'center' }}>{item.icon}</span>
          {!collapsed && item.label}
        </button>
      ))}

      <div style={{ flex: 1 }} />
      {footer}
    </nav>
  )
}
