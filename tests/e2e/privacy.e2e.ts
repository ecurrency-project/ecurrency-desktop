import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { acceptPrivacy, focusApp, focusedWindow } from './privacyHelpers'
import { encodeWif } from '../../src/main/brand/crypto'
import type { PrivacyApi } from '../../src/shared/privacy'

const PASSWORD = 'correct-horse-battery-staple'
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SENTINEL = 'public-clipboard-sentinel'
interface Harness { delay: boolean; captureError: boolean; lifecycle: readonly { time: number; event: string }[]; pending(): number; release(fail?: boolean): void }
// Capture artifacts are disabled: only public vectors are used, but no seed
// needs to enter traces/screenshots to test its DOM lifetime.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

async function launch() {
  const root = join(process.cwd(), 'test-results')
  mkdirSync(root, { recursive: true })
  const userData = mkdtempSync(join(root, 'privacy-user-data-'))
  const app = await electron.launch({ args: [join(process.cwd(), 'tests/e2e/privacy-harness.cjs'), `--user-data-dir=${userData}`] })
  const page = await focusedWindow(app)
  return { app, page }
}
async function importPrimary(page: Page) {
  await page.getByRole('button', { name: 'I already have a wallet' }).click()
  await acceptPrivacy(page)
  await page.getByLabel('Recovery phrase').fill(PHRASE)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel(/^(Wallet )?password$/i).fill(PASSWORD)
  await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Restore wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Open my wallet' }).click()
}
async function openReveal(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Reveal', exact: true }).click()
}
// One click starts the protected session and checks the typed password.
async function revealPhrase(page: Page) {
  await focusApp(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Show recovery phrase', exact: true }).click()
}
// Capture protection state of the window; null where the OS has no such API.
async function captureProtected(app: ElectronApplication): Promise<boolean | null> {
  return app.evaluate(({ BrowserWindow }) => process.platform === 'linux' ? null : BrowserWindow.getAllWindows()[0]!.isContentProtected())
}
async function hidden(page: Page) {
  expect(await page.evaluate(() => document.documentElement.outerHTML.includes('abandon'))).toBe(false)
  expect(await page.locator('body').ariaSnapshot().then((text) => text.includes('abandon'))).toBe(false)
  expect(await page.locator('input,textarea').evaluateAll((nodes) => nodes.some((node) => (node as HTMLInputElement).value.includes('abandon')))).toBe(false)
  await expect(page.getByTestId('seed-word')).toHaveCount(0)
}
async function delay(app: ElectronApplication, value: boolean) {
  await app.evaluate((_electron, value) => { (globalThis as unknown as { privacyHarness: Harness }).privacyHarness.delay = value }, value)
}
async function pending(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as unknown as { privacyHarness: Harness }).privacyHarness.pending())
}
async function release(app: ElectronApplication, fail: boolean) {
  await app.evaluate((_electron, fail) => (globalThis as unknown as { privacyHarness: Harness }).privacyHarness.release(fail), fail)
}
async function attachLifecycle(app: ElectronApplication, page: Page) {
  const state = {
    lifecycle: await app.evaluate(() => (globalThis as unknown as { privacyHarness: Harness }).privacyHarness.lifecycle),
    focused: await page.evaluate(() => document.hasFocus()),
    words: await page.getByTestId('seed-word').count(),
    checking: await page.getByRole('button', { name: 'Checking…', exact: true }).count(),
    passwordEmpty: await page.getByLabel(/^(Wallet )?password$/i).evaluateAll((nodes) => nodes.every((node) => (node as HTMLInputElement).value === '')),
  }
  const path = test.info().outputPath('privacy-lifecycle.json')
  writeFileSync(path, JSON.stringify(state, null, 2))
  await test.info().attach('privacy-lifecycle', { path, contentType: 'application/json' })
}

test('fresh password on each reveal; native blur and OS lock remove DOM and AX words', async () => {
  const { app, page } = await launch()
  try {
    await importPrimary(page)
    // Ordinary screens stay capturable; protection covers only the reveal.
    await expect.poll(() => captureProtected(app)).not.toBe(true)
    await openReveal(page)
    await page.getByLabel(/^(Wallet )?password$/i).fill(PASSWORD)
    await revealPhrase(page)
    await expect(page.getByTestId('seed-word')).toHaveCount(12)
    if (await captureProtected(app) !== null) expect(await captureProtected(app)).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit('blur'))
    await hidden(page)
    if (await captureProtected(app) !== null) await expect.poll(() => captureProtected(app)).toBe(false)
    await expect(page.getByLabel(/^(Wallet )?password$/i)).toHaveValue('')
    await hidden(page)
    await page.getByLabel(/^(Wallet )?password$/i).fill(PASSWORD)
    await revealPhrase(page)
    await expect(page.getByTestId('seed-word')).toHaveCount(12)
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'))
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await hidden(page)
  } catch (error) {
    await attachLifecycle(app, page)
    throw error
  } finally { await app.close() }
})

for (const fail of [false, true]) {
  test(`late ${fail ? 'error' : 'success'} and finally cannot affect a reopened reveal`, async () => {
    const { app, page } = await launch()
    try {
      await importPrimary(page); await openReveal(page); await delay(app, true)
      await page.getByLabel(/^(Wallet )?password$/i).fill(PASSWORD)
      await revealPhrase(page)
      await expect.poll(() => pending(app)).toBe(1)
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await openReveal(page)
      await page.getByLabel(/^(Wallet )?password$/i).fill(PASSWORD)
      await revealPhrase(page)
      await expect.poll(() => pending(app)).toBe(2)
      await release(app, fail)
      await hidden(page)
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Checking…' })).toBeDisabled()
      await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
      await release(app, false)
      await expect(page.getByTestId('seed-word')).toHaveCount(12)
    } catch (error) {
      await attachLifecycle(app, page)
      throw error
    } finally { await app.close() }
  })
}

test('seed input hides on blur, resumes its draft, cancels cleanly, and blocks native copy/cut while allowing paste', async () => {
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'I already have a wallet' }).click()
    await expect(page.getByLabel('Recovery phrase')).toHaveCount(0)
    await acceptPrivacy(page)
    const input = page.getByLabel('Recovery phrase')
    await app.evaluate(({ clipboard }, phrase) => clipboard.writeText(phrase), PHRASE)
    await input.focus(); await page.keyboard.press('ControlOrMeta+V')
    await expect(input).toHaveValue(PHRASE)
    // Positive control: the same native command must actually cut ordinary text.
    await page.evaluate(() => {
      const control = document.createElement('input')
      control.dataset.testid = 'public-cut-control'
      control.value = 'public-cut-control'
      document.body.append(control)
      control.focus(); control.select()
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()!.webContents.cut())
    await expect(page.getByTestId('public-cut-control')).toHaveValue('')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('public-cut-control')
    await page.getByTestId('public-cut-control').evaluate((node) => node.remove())
    await app.evaluate(({ clipboard }, sentinel) => clipboard.writeText(sentinel), SENTINEL)
    await input.focus()
    await input.selectText()
    await page.keyboard.press('ControlOrMeta+C')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(SENTINEL)
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getFocusedWindow()?.webContents
      if (!contents) throw new Error('Focused window missing')
      contents.cut()
    })
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(SENTINEL)
    await expect(input).toHaveValue(PHRASE)
    expect(await input.evaluate((node) => node.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })))).toBe(false)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await hidden(page)
    await acceptPrivacy(page)
    await expect(page.getByLabel('Recovery phrase')).toHaveValue(PHRASE)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'I already have a wallet' }).click()
    await acceptPrivacy(page)
    await expect(page.getByLabel('Recovery phrase')).toHaveValue('')
  } finally { await app.close() }
})

test('normalization-only edits and repeated paste keep a validated phrase usable', async () => {
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'I already have a wallet' }).click()
    await acceptPrivacy(page)
    const input = page.getByLabel('Recovery phrase')
    const next = page.getByRole('button', { name: 'Continue', exact: true })
    await input.fill(PHRASE)
    await expect(next).toBeEnabled()
    await input.press('End'); await input.press('Space')
    await expect(next).toBeEnabled()
    await input.fill(PHRASE.replaceAll(' ', '  ') + '\n')
    await expect(next).toBeEnabled()
    await app.evaluate(({ clipboard }, phrase) => clipboard.writeText(phrase), PHRASE)
    await page.getByRole('button', { name: 'Paste', exact: true }).click()
    await page.getByRole('button', { name: 'Paste', exact: true }).click()
    await expect(next).toBeEnabled()
  } finally { await app.close() }
})

test('password visibility toggles after editing and hides when focus leaves the field group', async () => {
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'Create a new wallet' }).click()
    const input = page.getByLabel(/^(Wallet )?password$/i)
    await input.fill(PASSWORD)
    await page.getByRole('button', { name: 'Show password' }).first().click()
    await input.focus(); await input.press('End'); await input.press('x')
    await page.getByRole('button', { name: 'Hide password' }).click()
    await expect(input).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: 'Show password' }).first().click()
    await input.focus(); await input.press('Tab')
    await expect(input).toHaveAttribute('type', 'text')
    await page.keyboard.press('Space')
    await expect(input).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: 'Show password' }).first().click()
    await page.getByLabel('Confirm password', { exact: true }).focus()
    await expect(input).toHaveAttribute('type', 'password')
  } finally { await app.close() }
})

test('password errors and retry metadata survive the actual context bridge', async () => {
  const { app, page } = await launch()
  try {
    expect(await page.evaluate(() => {
      const off = (window as unknown as { privacy: PrivacyApi }).privacy.onRevoked(() => {})
      return off()
    })).toBeUndefined()
    await importPrimary(page); await openReveal(page)
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/^(Wallet )?password$/i).fill('wrong')
    await revealPhrase(page)
    await expect(dialog.getByRole('alert')).toHaveText('Incorrect password — try again.')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    // One reveal failure + three unlock failures share the same main counter.
    for (let i = 0; i < 3; i++) {
      await page.getByLabel(/^(Wallet )?password$/i).fill('wrong')
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await expect(page.getByLabel(/^(Wallet )?password$/i)).toHaveValue('')
      await expect(page.getByText('Incorrect password — try again.')).toBeVisible()
    }
    await page.getByLabel(/^(Wallet )?password$/i).fill(PASSWORD)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.getByText(/Too many attempts\. Try again in \d+ seconds?\./)).toBeVisible()
  } finally { await app.close() }
})

test('password changes display the typed authentication error', async () => {
  const { app, page } = await launch()
  try {
    await importPrimary(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Change', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Current password', { exact: true }).fill('wrong')
    await dialog.getByLabel('New password', { exact: true }).fill('new-test-password')
    await dialog.getByLabel('Confirm new password', { exact: true }).fill('new-test-password')
    await dialog.getByRole('button', { name: 'Update password', exact: true }).click()
    await expect(dialog.getByText('Incorrect password — try again.')).toBeVisible()
  } finally { await app.close() }
})

test('renderer crash recovers automatically to a locked window without the old seed', async () => {
  const { app, page } = await launch()
  try {
    await importPrimary(page); await openReveal(page)
    await page.getByLabel(/^(Wallet )?password$/i).fill(PASSWORD)
    await revealPhrase(page)
    await expect(page.getByTestId('seed-word')).toHaveCount(12)
    const pid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer())
    await expect.poll(() => app.evaluate(({ BrowserWindow }, oldPid) => {
      const win = BrowserWindow.getAllWindows()[0]!
      return win.isVisible() && !win.webContents.isLoading() && win.webContents.getOSProcessId() !== oldPid
    }, pid)).toBe(true)
    // The crashed renderer invalidates Playwright's old Page session. Inspect
    // the fresh document through the surviving Electron main connection.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`({
      locked: document.body.innerText.includes('Welcome back'),
      words: document.querySelectorAll('[data-testid="seed-word"]').length,
      secret: document.documentElement.outerHTML.includes('abandon') || Array.from(document.querySelectorAll('input,textarea')).some(node => node.value.includes('abandon'))
    })`))).toEqual({ locked: true, words: 0, secret: false })
  } finally { await app.close() }
})

test('restore errors remain visible after its input session is revoked', async () => {
  const { app, page } = await launch()
  try {
    await importPrimary(page)
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await page.getByRole('button', { name: 'Forgot password? Restore from recovery phrase' }).click()
    await acceptPrivacy(page)
    await page.getByLabel('Recovery phrase').fill('not a valid recovery phrase')
    await page.getByLabel('New password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Restore wallet', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('That recovery phrase is not valid.')
    await expect(page.getByLabel('Recovery phrase')).toHaveCount(0)
  } finally { await app.close() }
})

for (const flow of ['import', 'sweep'] as const) {
  test(`${flow} preserves Schnorr across privacy pause and lets the public address be copied`, async () => {
    const { app, page } = await launch()
    const wif = encodeWif(new Uint8Array(32).fill(1), 'mainnet')
    try {
      await importPrimary(page)
      if (flow === 'import') {
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.getByRole('button', { name: 'Add wallet', exact: true }).click()
        await page.getByRole('dialog').getByRole('tab', { name: 'Private key', exact: true }).click()
      } else {
        await page.locator('.wallet-switch').click()
        await page.getByRole('button', { name: 'Send from a key', exact: true }).click()
      }
      const dialog = page.getByRole('dialog')
      await acceptPrivacy(dialog)
      await dialog.getByLabel('Private key').fill(wif)
      await dialog.getByRole('tab', { name: 'Schnorr', exact: true }).click()
      const address = await dialog.locator('code').textContent()
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await expect(dialog.getByLabel('Private key')).toHaveCount(0)
      await acceptPrivacy(dialog)
      await expect(dialog.getByRole('tab', { name: 'Schnorr', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(dialog.locator('code')).toHaveText(address!)
      await dialog.locator('code').selectText()
      await page.keyboard.press('ControlOrMeta+C')
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(address)
      if (flow === 'import') {
        await app.evaluate(({ clipboard }, wif) => clipboard.writeText(wif), wif)
        await dialog.getByRole('button', { name: 'Add wallet', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('')
      }
    } finally { await app.close() }
  })
}

test('seed/passphrase and WIF forms clear on mode change/close and hide until explicitly resumed', async () => {
  const { app, page } = await launch()
  try {
    await importPrimary(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Add wallet', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('tab', { name: 'Recovery phrase', exact: true }).click()
    await acceptPrivacy(dialog)
    await dialog.getByLabel('Recovery phrase').fill(PHRASE)
    await dialog.getByLabel('BIP39 passphrase').fill('public-test-passphrase')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await hidden(page)
    await expect(dialog.getByLabel('BIP39 passphrase')).toHaveCount(0)
    await acceptPrivacy(dialog)
    await expect(dialog.getByLabel('BIP39 passphrase')).toHaveValue('public-test-passphrase')
    await dialog.getByRole('tab', { name: 'Private key', exact: true }).click()
    await acceptPrivacy(dialog)
    await expect(dialog.getByLabel('Private key')).toHaveValue('')
    await dialog.getByLabel('Private key').fill('public-invalid-WIF')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(dialog.getByLabel('Private key')).toHaveCount(0)
    await acceptPrivacy(dialog)
    await expect(dialog.getByLabel('Private key')).toHaveValue('public-invalid-WIF')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Add wallet', exact: true }).click()
    await dialog.getByRole('tab', { name: 'Private key', exact: true }).click()
    await acceptPrivacy(dialog)
    await expect(dialog.getByLabel('Private key')).toHaveValue('')
  } finally { await app.close() }
})

test('timeout hides a revealed phrase without automatic redisplay', async () => {
  const { app, page } = await launch()
  try {
    await importPrimary(page)
    await page.clock.install()
    // Reload creates every controller/timer against the installed clock. Main
    // locks on navigation; its independent deadline is covered by unit tests.
    await page.reload()
    await page.getByLabel(/^(Wallet )?password$/i).fill(PASSWORD)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await openReveal(page)
    await page.getByLabel(/^(Wallet )?password$/i).fill(PASSWORD)
    await revealPhrase(page)
    await expect(page.getByTestId('seed-word')).toHaveCount(12)
    await page.clock.fastForward(120_001)
    await hidden(page)
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Show recovery phrase', exact: true })).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await hidden(page)
  } finally { await app.close() }
})

test('sweep key draft is removed on blur and discarded on close', async () => {
  const { app, page } = await launch()
  try {
    await importPrimary(page)
    await page.locator('.wallet-switch').click()
    await page.getByRole('button', { name: 'Send from a key', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Private key')).toHaveCount(0)
    await acceptPrivacy(dialog)
    await dialog.getByLabel('Private key').fill('public-invalid-WIF')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(dialog.getByLabel('Private key')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.outerHTML.includes('public-invalid-WIF'))).toBe(false)
    await acceptPrivacy(dialog)
    await expect(dialog.getByLabel('Private key')).toHaveValue('public-invalid-WIF')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.locator('.wallet-switch').click()
    await page.getByRole('button', { name: 'Send from a key', exact: true }).click()
    await acceptPrivacy(dialog)
    await expect(dialog.getByLabel('Private key')).toHaveValue('')
  } finally { await app.close() }
})

test('public watch descriptor copying remains available', async () => {
  const { app, page } = await launch()
  try {
    await importPrimary(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const descriptor = dialog.getByRole('textbox', { name: 'Watch descriptor', exact: true })
    await expect(descriptor).not.toHaveValue('', { timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(await descriptor.inputValue())
  } finally { await app.close() }
})

test('unexpected protection failure offers a retry and never mounts secret fields', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(() => { (globalThis as unknown as { privacyHarness: Harness }).privacyHarness.captureError = true })
    await page.getByRole('button', { name: 'I already have a wallet' }).click()
    await expect(page.getByTestId('privacy-continue')).toHaveText('Try again')
    await expect(page.getByLabel('Recovery phrase')).toHaveCount(0)
    await app.evaluate(() => { (globalThis as unknown as { privacyHarness: Harness }).privacyHarness.captureError = false })
    // "Try again" re-checks protection and starts the session in the same click.
    await acceptPrivacy(page)
    await expect(page.getByLabel('Recovery phrase')).toBeVisible()
  } finally { await app.close() }
})
