import { expect, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

export function freshUserData(): string {
  const root = join(process.cwd(), 'test-results')
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, 'wallet-user-data-'))
}

export async function focusApp(scope: Page | Locator): Promise<void> {
  const page = 'page' in scope ? scope.page() : scope
  await page.evaluate(() => window.focus())
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
}

// Starts a protected session through the gate's single action, whose label names
// the task ("Show recovery phrase", "Enter private key", …).
export async function acceptPrivacy(scope: Page | Locator): Promise<void> {
  await focusApp(scope)
  await scope.getByTestId('privacy-continue').click()
}
