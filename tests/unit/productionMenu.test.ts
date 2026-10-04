import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { buildAppMenu } from '../../src/main/menu'

const state = vi.hoisted(() => ({ packaged: true, template: [] as MenuItemConstructorOptions[] }))
vi.mock('electron', () => ({
  app: { get isPackaged() { return state.packaged }, getVersion: () => 'test' },
  dialog: {}, shell: {},
  Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => { state.template = template; return {} } },
}))
vi.mock('../../src/main/updater', () => ({ checkForUpdatesInteractive: vi.fn() }))
function roles(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [item.role ?? '', ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])])
}

describe('production menu', () => {
  it('keeps zoom/edit but excludes the default reload/devtools submenu', () => {
    state.packaged = true
    buildAppMenu(vi.fn())
    const values = roles(state.template)
    expect(values).toContain('editMenu')
    expect(values).toContain('zoomIn')
    for (const forbidden of ['viewMenu', 'reload', 'forceReload', 'toggleDevTools', 'services']) expect(values).not.toContain(forbidden)
  })
  it('keeps developer tools in development only', () => {
    state.packaged = false
    buildAppMenu(vi.fn())
    expect(roles(state.template)).toContain('viewMenu')
  })
  it('exposes release history in Help even without a brand homepage', () => {
    const showChangelog = vi.fn()
    buildAppMenu(showChangelog)
    const help = state.template.find((item) => item.role === 'help')
    expect(Array.isArray(help?.submenu)).toBe(true)
    const items = help!.submenu as MenuItemConstructorOptions[]
    expect(items.find((item) => item.label === 'What’s new')?.click).toBe(showChangelog)
  })
})
