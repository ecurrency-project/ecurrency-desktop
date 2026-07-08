import { app, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { HOMEPAGE, PRODUCT_NAME } from './appInfo'
import { checkForUpdatesInteractive } from './updater'

// Application menu. Labels come from appInfo (a BRAND FILE) — never from
// app.getName(), which reports the raw package name and, more importantly,
// must stay untouched because userData derives from it.

export function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin'

  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => {
      void checkForUpdatesInteractive()
    },
  }

  const aboutItem: MenuItemConstructorOptions = {
    label: `About ${PRODUCT_NAME}`,
    click: () => {
      void dialog.showMessageBox({
        type: 'info',
        title: `About ${PRODUCT_NAME}`,
        message: PRODUCT_NAME,
        detail: `Version ${app.getVersion()}`,
        buttons: ['OK'],
      })
    },
  }

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: PRODUCT_NAME, // the menu-bar title itself comes from Info.plist
      submenu: [
        aboutItem,
        checkForUpdatesItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${PRODUCT_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${PRODUCT_NAME}` },
      ],
    })
  }

  template.push({ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' })

  const helpItems: MenuItemConstructorOptions[] = []
  if (HOMEPAGE !== null) {
    const url = HOMEPAGE
    helpItems.push({ label: 'Learn More', click: () => void shell.openExternal(url) })
  }
  if (!isMac) {
    // No app menu on Windows/Linux — surface these under Help.
    if (helpItems.length > 0) helpItems.push({ type: 'separator' })
    helpItems.push(checkForUpdatesItem, aboutItem)
  }
  if (helpItems.length > 0) {
    template.push({ role: 'help', submenu: helpItems })
  }

  return Menu.buildFromTemplate(template)
}
