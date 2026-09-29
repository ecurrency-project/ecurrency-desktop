import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const applications = new WeakMap<Page, ElectronApplication>()

export async function focusedWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  applications.set(page, app)
  await focusApp(page)
  return page
}

// Capture protection state of the window; null where the OS has no such API.
export async function captureProtected(app: ElectronApplication): Promise<boolean | null> {
  return app.evaluate(({ BrowserWindow }) => process.platform === 'linux' ? null : BrowserWindow.getAllWindows()[0]!.isContentProtected())
}

export function freshUserData(): string {
  const root = join(process.cwd(), 'test-results')
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, 'wallet-user-data-'))
}

export async function focusApp(scope: Page | Locator): Promise<void> {
  const page = 'page' in scope ? scope.page() : scope
  const application = applications.get(page)
  if (application) {
    // On macOS the application can be hidden while document.hasFocus() remains
    // true. Restore the native window before an explicit protected UI action.
    await application.evaluate(({ app, BrowserWindow }) => {
      if (process.platform === 'darwin') app.show()
      app.focus({ steal: true })
      const window = BrowserWindow.getAllWindows()[0]
      window?.show(); window?.focus()
    })
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return !!window && window.isVisible() && window.isFocused() && !window.isMinimized()
    })).toBe(true)
  }
  await page.evaluate(() => window.focus())
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
}

// Starts a protected session through the gate's single action, whose label names
// the task ("Show recovery phrase", "Enter private key", …).
export async function acceptPrivacy(scope: Page | Locator): Promise<void> {
  await focusApp(scope)
  await scope.getByTestId('privacy-continue').click()
}
