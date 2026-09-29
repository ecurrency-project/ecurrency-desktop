import { join } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { falcon512KeygenFromSeed, getPublicKey, schnorrGetPublicKey } from '@qbtc/crypto'
import { addressFromPubkey, encodeWif } from '../../src/main/brand/crypto'
import { acceptPrivacy, focusApp, focusedWindow, freshUserData } from './privacyHelpers'
import type { BridgeApi } from '../../src/shared/bridge'
import type { WalletApi } from '../../src/shared/protocol'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
const PASSWORD = 'backup-test-password'
const PRIMARY = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SECOND = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
interface Harness { delay: boolean; pending(): number; release(): void }

async function launch() {
  const app = await electron.launch({ args: [join(process.cwd(), 'tests/e2e/privacy-harness.cjs'), `--user-data-dir=${freshUserData()}`] })
  const page = await focusedWindow(app)
  await page.getByRole('button', { name: 'I already have a wallet' }).click()
  await acceptPrivacy(page)
  await page.getByLabel('Recovery phrase').fill(PRIMARY)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Restore wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Open my wallet' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  return { app, page }
}
async function addSeed(page: Page, passphrase: string) {
  await page.getByRole('button', { name: 'Add wallet', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('tab', { name: 'Recovery phrase', exact: true }).click()
  await acceptPrivacy(dialog)
  await dialog.getByLabel('Wallet name').fill('Savings')
  await dialog.getByLabel('Recovery phrase').fill(SECOND)
  await dialog.getByLabel('BIP39 passphrase').fill(passphrase)
  await dialog.getByRole('button', { name: 'Add wallet', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.wallet-switch')).toContainText('Savings')
}
async function openReveal(page: Page, key = false) {
  await page.getByRole('button', { name: 'Reveal', exact: true }).click()
  await page.getByLabel('Wallet password', { exact: true }).fill(PASSWORD)
  await focusApp(page)
  await page.getByRole('dialog').getByRole('button', { name: key ? 'Show private key' : 'Show recovery phrase', exact: true }).click()
}
async function wordsEqual(page: Page, phrase: string) {
  await expect(page.getByTestId('seed-word')).toHaveCount(12)
  // Boolean assertions keep recovery material out of failure reports.
  expect((await page.getByTestId('seed-word').allTextContents()).join(' ') === phrase).toBe(true)
}

for (const passphrase of ['  Café e\u0301 密碼  ', '   ']) {
  test(`selected seed backup preserves ${passphrase.trim() ? 'Unicode and surrounding spaces' : 'a whitespace-only passphrase'}`, async () => {
    const { app, page } = await launch()
    try {
      await addSeed(page, passphrase)
      await openReveal(page)
      await wordsEqual(page, SECOND)
      expect(await page.getByTestId('backup-secret').textContent() === passphrase).toBe(true)
      await page.getByRole('button', { name: 'Hide now', exact: true }).click()
      await expect(page.getByTestId('backup-secret')).toHaveCount(0)
      await expect(page.getByTestId('seed-word')).toHaveCount(0)
      await expect(page.getByLabel('Wallet password')).toHaveValue('')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.locator('.wallet-switch').click()
      await page.getByRole('menuitemradio', { name: 'Main wallet', exact: true }).click()
      await expect(page.locator('.wallet-switch')).toHaveText('Main wallet')
      await openReveal(page)
      await wordsEqual(page, PRIMARY)
      await expect(page.getByTestId('backup-secret')).toHaveCount(0)
    } finally { await app.close() }
  })
}

for (const algo of ['ecdsa', 'schnorr', 'falcon512'] as const) {
  test(`${algo} backup shows only its complete WIF and clears it on blur`, async () => {
    const { app, page } = await launch()
    let wif: string, address: string
    if (algo === 'falcon512') {
      const kp = await falcon512KeygenFromSeed(new Uint8Array(48).fill(7))
      const payload = new Uint8Array([...kp.privateKey, ...kp.publicKey])
      wif = encodeWif(payload, 'mainnet')
      address = addressFromPubkey(kp.publicKey, algo, 'mainnet')
      payload.fill(0); kp.privateKey.fill(0)
    } else {
      const scalar = new Uint8Array(32).fill(1)
      wif = encodeWif(scalar, 'mainnet')
      address = addressFromPubkey(algo === 'schnorr' ? schnorrGetPublicKey(scalar) : getPublicKey(scalar), algo, 'mainnet')
      scalar.fill(0)
    }
    try {
      await page.getByRole('button', { name: 'Add wallet', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('tab', { name: 'Private key', exact: true }).click()
      await acceptPrivacy(dialog)
      await dialog.getByLabel('Private key', { exact: true }).fill(wif)
      if (algo === 'schnorr') await dialog.getByRole('tab', { name: 'Schnorr', exact: true }).click()
      await expect(dialog.locator('code')).toHaveText(address)
      await dialog.getByRole('button', { name: 'Add wallet', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByText('Recovery phrase', { exact: true })).toHaveCount(0)
      await openReveal(page, true)
      const secret = page.getByTestId('backup-secret')
      await expect(secret).toBeVisible()
      expect(await secret.textContent() === wif).toBe(true)
      await expect(page.getByTestId('seed-word')).toHaveCount(0)
      await expect(dialog.getByText(`Address: ${address}`, { exact: true })).toBeVisible()
      await expect(dialog.getByText(`Algorithm: ${algo === 'falcon512' ? 'Falcon-512' : algo === 'schnorr' ? 'Schnorr' : 'ECDSA'}`, { exact: true })).toBeVisible()
      expect(await secret.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      expect(await secret.evaluate((node) => getComputedStyle(node).userSelect)).toBe('none')
      await app.evaluate(({ clipboard }) => clipboard.writeText('public-sentinel'))
      await secret.evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range) })
      await page.keyboard.press('ControlOrMeta+C')
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('public-sentinel')
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await expect(secret).toHaveCount(0)
      await expect(page.getByLabel('Wallet password')).toHaveValue('')
      expect(await page.evaluate((value) => document.documentElement.outerHTML.includes(value), wif)).toBe(false)
    } finally { await app.close() }
  })
}

test('an in-transit backup from another wallet cannot populate a new dialog', async () => {
  const { app, page } = await launch()
  try {
    await addSeed(page, '')
    await app.evaluate(() => { (globalThis as unknown as { privacyHarness: Harness }).privacyHarness.delay = true })
    await openReveal(page)
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { privacyHarness: Harness }).privacyHarness.pending())).toBe(1)
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    await page.locator('.wallet-switch').click()
    await page.getByRole('menuitemradio', { name: 'Main wallet', exact: true }).click()
    await expect(page.locator('.wallet-switch')).toHaveText('Main wallet')
    await page.getByRole('button', { name: 'Reveal', exact: true }).click()
    await app.evaluate(() => { const h = (globalThis as unknown as { privacyHarness: Harness }).privacyHarness; h.delay = false; h.release() })
    // A subsequent IPC round trip flushes the already released response.
    await page.evaluate(() => (window as unknown as { wallet: BridgeApi<WalletApi> }).wallet.ping())
    await expect(page.getByTestId('seed-word')).toHaveCount(0)
    await expect(page.getByLabel('Wallet password')).toHaveValue('')
    await page.getByLabel('Wallet password').fill(PASSWORD)
    await focusApp(page)
    await page.getByRole('button', { name: 'Show recovery phrase', exact: true }).click()
    await expect.poll(async () => ({ words: await page.getByTestId('seed-word').count(), errors: await page.getByRole('alert').allTextContents(), checking: await page.getByRole('button', { name: 'Checking…', exact: true }).count() })).toEqual({ words: 12, errors: [], checking: 0 })
    await wordsEqual(page, PRIMARY)
  } finally { await app.close() }
})

test('watch address lists export fully and never offer a secret', async () => {
  const { app, page } = await launch()
  const scalar = new Uint8Array(32).fill(2)
  const addresses = [addressFromPubkey(getPublicKey(scalar), 'ecdsa', 'mainnet'), addressFromPubkey(schnorrGetPublicKey(scalar), 'schnorr', 'mainnet')]
  try {
    await page.getByRole('button', { name: 'Add wallet', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('tab', { name: 'Addresses', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Addresses', exact: true }).fill(addresses.join('\n'))
    await dialog.getByRole('button', { name: 'Add wallet', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Watch addresses', exact: true })).toHaveValue(addresses.join('\n'))
    await focusApp(page)
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(addresses.join('\n'))
  } finally { scalar.fill(0); await app.close() }
})
