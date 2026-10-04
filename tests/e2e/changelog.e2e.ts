import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { focusedWindow, freshUserData } from './privacyHelpers'
import { version } from '../../package.json'
import type { BridgeApi } from '../../src/shared/bridge'
import type { WalletApi } from '../../src/shared/protocol'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSWORD = 'changelog-test-password'
const releaseVersion = /^## (\d+\.\d+\.\d+) —/m.exec(readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf8'))?.[1]

async function openFromHelp(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu()?.items.find((entry) => entry.role === 'help')?.submenu?.items.find((entry) => entry.label === 'What’s new')
    if (!item) throw new Error('Missing changelog menu item')
    item.click(undefined, BrowserWindow.getAllWindows()[0], undefined)
  })
}

test('release history works offline before setup, while locked and from the sidebar', async () => {
  const app = await electron.launch({ args: [join(process.cwd(), 'out/main/index.js'), `--user-data-dir=${freshUserData()}`] })
  const page = await focusedWindow(app)
  try {
    await page.context().setOffline(true)
    await expect(page.getByRole('button', { name: 'I already have a wallet' })).toBeVisible()
    await openFromHelp(app)
    const dialog = page.getByRole('dialog', { name: 'What’s new' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(`Installed version ${version}`, { exact: false })).toBeVisible()
    if (releaseVersion) await expect(dialog.getByRole('heading', { name: releaseVersion, exact: true })).toBeVisible()
    else await expect(dialog.getByText('Release notes are not available for this build.')).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'What’s new' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Close changelog' })).toBeFocused()
    await page.keyboard.press('Tab')
    const history = dialog.getByRole('region', { name: 'Release history' })
    await expect(history).toBeFocused()
    if (await history.evaluate((element) => element.scrollHeight > element.clientHeight)) {
      await history.press('PageDown')
      await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    }
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    // A disposable vault lets us verify the locked route without showing secrets.
    await page.evaluate(async ({ phrase, password }) => {
      const wallet = (window as unknown as { wallet: BridgeApi<WalletApi> }).wallet
      const result = await wallet.create(phrase, password)
      if (!result.ok) throw new Error('Test wallet creation failed')
      await wallet.lock()
    }, { phrase: PHRASE, password: PASSWORD })
    await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible()
    await openFromHelp(app)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close changelog' }).click()
    await expect(dialog).not.toBeVisible()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()

    const link = page.getByRole('button', { name: `What’s new · Version ${version}`, exact: true })
    await link.click()
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('changelog-dark.png') })
    await page.keyboard.press('Escape')
    await expect(link).toBeFocused()
    await page.getByRole('button', { name: 'Toggle light and dark theme' }).click()
    await page.getByRole('button', { name: 'Toggle sidebar' }).click()
    await link.click()
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('changelog-light.png') })
    await page.mouse.click(5, 300)
    await expect(dialog).not.toBeVisible()
  } finally {
    await app.close()
  }
})
