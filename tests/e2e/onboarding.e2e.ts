import { acceptPrivacy, captureProtected, focusedWindow, freshUserData } from './privacyHelpers'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

// The built main entry. `pnpm test:e2e` builds first, so out/ is current.
const MAIN = join(process.cwd(), 'out', 'main', 'index.js')
const PASSWORD = 'correct-horse-battery-staple'
// A standard BIP-39 test vector — valid words and checksum.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Launch a fresh instance with an isolated, throwaway user-data directory so each
// test starts at onboarding (no vault on disk yet). Electron honours --user-data-dir.
async function launchFresh(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = freshUserData()
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] })
  const page = await focusedWindow(app)
  return { app, page }
}

test('create a wallet, confirm the phrase, then lock and unlock', async () => {
  const { app, page } = await launchFresh()
  try {
    await page.getByRole('button', { name: 'Create a new wallet' }).click()

    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    // A mismatch shows only after the field is left, and is tied to that field.
    const confirmPassword = page.getByLabel('Confirm password', { exact: true })
    await confirmPassword.fill(`${PASSWORD}-typo`)
    await expect(page.getByText("Passwords don't match yet.")).toHaveCount(0)
    await confirmPassword.blur()
    await expect(confirmPassword).toHaveAttribute('aria-invalid', 'true')
    await expect(confirmPassword).toHaveAccessibleDescription("Passwords don't match yet.")
    await confirmPassword.fill(PASSWORD)
    await expect(confirmPassword).not.toHaveAttribute('aria-invalid')
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByTestId('seed-word')).toHaveCount(0)
    await expect(page.getByTestId('seed-placeholder')).toHaveCount(12)
    await acceptPrivacy(page)
    await expect(page.getByTestId('seed-word')).toHaveCount(12)
    const words = await page.getByTestId('seed-word').allTextContents()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(page.getByTestId('seed-word')).toHaveCount(0)
    await acceptPrivacy(page)
    await expect(page.getByTestId('seed-word')).toHaveCount(12)
    expect(await page.getByTestId('seed-word').allTextContents()).toEqual(words)

    await page.getByRole('switch', { name: "I've saved these words somewhere safe" }).click()
    await page.getByRole('button', { name: "I've written it down" }).click()

    // The quiz shows no secret: no gate, no countdown, and the window stays capturable.
    await expect(page.getByRole('heading', { name: 'Confirm your phrase' })).toBeVisible()
    await expect(page.getByTestId('privacy-continue')).toHaveCount(0)
    await expect(page.getByRole('timer')).toHaveCount(0)
    await expect.poll(() => captureProtected(app)).not.toBe(true)

    // Fill each quizzed word using the index encoded in its aria-label ("Word N").
    const fields = page.locator('input[aria-label^="Word "]')
    await expect(fields).toHaveCount(3)
    // A wrong word is flagged only after the field is left, with text as well as color.
    const first = fields.first()
    await first.fill('zzzz')
    await expect(first).not.toHaveAttribute('aria-invalid')
    await first.blur()
    await expect(first).toHaveAttribute('aria-invalid', 'true')
    await expect(first).toHaveAccessibleDescription(/^That's not word #\d+ of your phrase\.$/)
    for (let i = 0; i < (await fields.count()); i++) {
      const field = fields.nth(i)
      const aria = (await field.getAttribute('aria-label')) ?? ''
      const n = Number(aria.replace('Word ', ''))
      await field.fill(words[n - 1])
    }
    await expect(first).not.toHaveAttribute('aria-invalid')
    await expect(first).toHaveAccessibleDescription('Matches')
    // Leaving the window to look at the written backup keeps the typed words.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(fields).toHaveCount(3)
    await page.getByRole('button', { name: 'Confirm' }).click()

    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible()
    await page.getByRole('button', { name: 'Open my wallet' }).click()
    await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible()

    // Lock; a wrong password marks the field invalid and describes why; then unlock.
    await page.getByRole('button', { name: 'Lock' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    const unlockPassword = page.getByLabel('Password', { exact: true })
    await unlockPassword.fill('not-the-password')
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(unlockPassword).toHaveAttribute('aria-invalid', 'true')
    await expect(unlockPassword).toHaveAccessibleDescription('Incorrect password — try again.')
    await unlockPassword.fill(PASSWORD)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('fields keep a visible focus indicator, also in forced colors', async () => {
  const { app, page } = await launchFresh()
  try {
    await page.getByRole('button', { name: 'I already have a wallet' }).click()
    await acceptPrivacy(page)
    await page.getByLabel('Recovery phrase').fill(PHRASE)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Restore wallet' }).click()
    await page.getByRole('button', { name: 'Open my wallet' }).click()
    // Native parts follow the default dark theme.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Send', exact: true }).click()
    const amount = page.getByLabel(/^Amount in /)
    const recipient = page.getByLabel('Recipient address')
    // The amount's wrapper draws the ring its borderless input cannot.
    await amount.focus()
    expect(await amount.evaluate((input) => getComputedStyle(input.parentElement!).boxShadow)).not.toBe('none')
    // Forced colors drop shadows, so fields fall back to a solid outline.
    await page.emulateMedia({ forcedColors: 'active' })
    await recipient.focus()
    expect(await recipient.evaluate((input) => { const style = getComputedStyle(input); return style.outlineStyle === 'solid' && style.outlineWidth === '2px' })).toBe(true)
    await amount.focus()
    expect(await amount.evaluate((input) => getComputedStyle(input.parentElement!).outlineStyle)).toBe('solid')
  } finally {
    await app.close()
  }
})

test('import an existing recovery phrase', async () => {
  const { app, page } = await launchFresh()
  try {
    await page.getByRole('button', { name: 'I already have a wallet' }).click()
    await acceptPrivacy(page)
    await page.getByLabel('Recovery phrase').fill(PHRASE)
    await page.getByRole('button', { name: 'Continue' }).click()

    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Restore wallet' }).click()

    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible()
    await page.getByRole('button', { name: 'Open my wallet' }).click()
    await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('forgot password — restore from the recovery phrase with a new password', async () => {
  const { app, page } = await launchFresh()
  try {
    // Set up a wallet from a known phrase.
    await page.getByRole('button', { name: 'I already have a wallet' }).click()
    await acceptPrivacy(page)
    await page.getByLabel('Recovery phrase').fill(PHRASE)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Restore wallet' }).click()
    await page.getByRole('button', { name: 'Open my wallet' }).click()
    await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible()

    // Lock, then recover via the recovery phrase + a NEW password (forgot the old one).
    await page.getByRole('button', { name: 'Lock' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await page.getByRole('button', { name: 'Forgot password? Restore from recovery phrase' }).click()
    await expect(page.getByRole('heading', { name: 'Restore wallet' })).toBeVisible()
    await acceptPrivacy(page)
    await page.getByLabel('Recovery phrase').fill(PHRASE)
    const NEW_PASSWORD = 'a-brand-new-password'
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('Confirm password', { exact: true }).fill(NEW_PASSWORD)
    await page.getByRole('button', { name: 'Restore wallet' }).click()
    await expect(page.getByText('Wallet restored. Enter your new password to unlock.')).toBeVisible()
    await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})
