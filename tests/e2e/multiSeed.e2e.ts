import { acceptPrivacy, freshUserData } from './privacyHelpers'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// The built main entry. `pnpm test:e2e` builds first, so out/ is current.
const MAIN = join(process.cwd(), 'out', 'main', 'index.js')
const PASSWORD = 'correct-horse-battery-staple'
// Two distinct, valid BIP-39 test vectors (words + checksum).
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SECOND = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

// Import a second seed wallet from its recovery phrase, switch to it, confirm it can
// sign (Send is NOT blocked, unlike a watch wallet), then remove it.
test('import a second seed wallet, see it sign-capable, then remove it', async () => {
  const userData = freshUserData()
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] })
  const page = await app.firstWindow()
  try {
    // Onboard the primary wallet by importing a known phrase.
    await page.getByRole('button', { name: 'I already have a wallet' }).click()
    await acceptPrivacy(page)
    await page.getByLabel('Recovery phrase').fill(PHRASE)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Restore wallet' }).click()
    await page.getByRole('button', { name: 'Open my wallet' }).click()
    await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible()

    // Settings → Accounts → Add wallet → Recovery phrase.
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Add wallet' }).click() // the Accounts action (dialog not yet open)
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('tab', { name: 'Recovery phrase' }).click()
    await acceptPrivacy(dialog)
    await dialog.getByLabel('Wallet name').fill('Savings')
    await dialog.getByLabel('Recovery phrase').fill(SECOND)
    await dialog.getByRole('button', { name: 'Add wallet' }).click()

    // It becomes the active wallet (shown in the switcher + Accounts list).
    await expect(page.getByRole('button', { name: 'Savings', exact: true })).toBeVisible()

    // A seed wallet can sign: Send shows the form, not the watch-only notice.
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Watch-only wallet')).toHaveCount(0)

    // Remove it from Accounts (only non-primary wallets have a Remove control).
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Remove wallet' }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByText('Savings')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
