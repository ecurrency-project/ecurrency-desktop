import { acceptPrivacy, focusedWindow, freshUserData } from './privacyHelpers'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// The built main entry. `pnpm test:e2e` builds first, so out/ is current.
const MAIN = join(process.cwd(), 'out', 'main', 'index.js')
const PASSWORD = 'correct-horse-battery-staple'
// A standard BIP-39 test vector — valid words and checksum.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Full watch-only round-trip against the real UI: the seed wallet exports its watch
// descriptor, which is added back as a watch wallet (so it needs no external address),
// then we assert the watch-mode treatment (WATCH badge, Send disabled) and removal.
test('export a descriptor, add it as a watch wallet, see it blocked, then remove it', async () => {
  const userData = freshUserData()
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] })
  const page = await focusedWindow(app)
  try {
    // Onboard quickly by importing a known phrase.
    await page.getByRole('button', { name: 'I already have a wallet' }).click()
    await acceptPrivacy(page)
    await page.getByLabel('Recovery phrase').fill(PHRASE)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Restore wallet' }).click()
    await page.getByRole('button', { name: 'Open my wallet' }).click()
    await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible()

    // Settings → export this seed wallet's watch descriptor.
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Export' }).click()
    const exported = page.getByRole('textbox', { name: 'Watch descriptor', exact: true })
    await expect(exported).toBeVisible({ timeout: 30_000 }) // Falcon address derivation is WASM
    const descriptor = await exported.inputValue()
    expect(descriptor).toContain('qbt-watch')
    await page.getByRole('dialog').locator('.modal-close').click()

    // Accounts → add it back as a watch-only wallet.
    await page.getByRole('button', { name: 'Add wallet' }).click()
    await page.getByLabel('Wallet name').fill('Cold vault')
    await page.getByRole('textbox', { name: 'Watch descriptor', exact: true }).fill(descriptor)
    await page.getByRole('dialog').getByRole('button', { name: 'Add wallet' }).click()

    // It becomes active: the top-bar switcher shows the WATCH badge.
    await expect(page.getByText('WATCH', { exact: true })).toBeVisible()

    // Send is blocked for a watch wallet — the form is replaced by a notice.
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Watch-only wallet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Review send' })).toHaveCount(0)

    // Remove it from Accounts; the watch wallet (and the badge) disappear.
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Watch descriptor', exact: true })).toHaveValue(descriptor)
    await page.getByRole('dialog').locator('.modal-close').click()
    await page.getByRole('button', { name: 'Remove wallet' }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByText('Cold vault')).toHaveCount(0)
    await expect(page.getByText('WATCH', { exact: true })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
