/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Test-only Electron bootstrap. */
const { ipcMain } = require('electron')
const { join } = require('node:path')

// Delay delivery AFTER real main authorization/KDF. This exercises renderer
// rejection of a reply already in transit when a dialog closes. Never shipped.
const queued = []
globalThis.privacyHarness = {
  delay: false,
  captureError: false,
  pending: () => queued.length,
  release: (fail = false) => {
    const next = queued.shift()
    if (next) next(fail)
  },
}
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => handle(channel, async (event, request) => {
  if (channel === 'privacy:request' && globalThis.privacyHarness.captureError) {
    if (request?.type === 'status') return { ok: true, value: 'error' }
    if (request?.type === 'begin') return { ok: false, error: { name: 'Error', message: 'Test capture failure' } }
  }
  const result = await listener(event, request)
  if (request?.type === 'vault.revealMnemonic' && globalThis.privacyHarness.delay) {
    const fail = await new Promise((resolve) => queued.push(resolve))
    if (fail) return { ok: false, error: { name: 'InvalidPasswordError', message: 'Test failure' } }
  }
  return result
})
require(join(__dirname, '../../out/main/index.js'))
