/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Test-only Electron bootstrap. */
const { app, ipcMain } = require('electron')
const { join } = require('node:path')

// Delay delivery AFTER real main authorization/KDF. This exercises renderer
// rejection of a reply already in transit when a dialog closes. Never shipped.
const queued = []
// Metadata only: no request payloads, passwords, session IDs or secret replies.
const lifecycle = []
const record = (event) => lifecycle.push({ time: Date.now(), event })
app.on('browser-window-created', (_event, window) => {
  const setContentProtection = window.setContentProtection.bind(window)
  window.setContentProtection = (enabled) => {
    record(`capture:set:${enabled}`)
    try {
      setContentProtection(enabled)
    } catch (error) {
      record('capture:set:error')
      throw error
    }
    try { record(`capture:state:${window.isContentProtected()}`) }
    catch { record('capture:state:error') }
  }
  for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'unresponsive', 'responsive']) window.on(event, () => record(`window:${event}`))
  const hide = window.hide.bind(window)
  window.hide = () => { record('call:window.hide'); return hide() }
  const send = window.webContents.send.bind(window.webContents)
  window.webContents.send = (channel, ...args) => {
    if (channel === 'privacy:revoked') record(`revoke:${args[0]?.reason}`)
    return send(channel, ...args)
  }
})
globalThis.privacyHarness = {
  lifecycle,
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
  const tracked = channel === 'privacy:request' || request?.type === 'wallets.revealBackup'
  if (tracked) record(`request:${request?.type}`)
  if (channel === 'privacy:request' && globalThis.privacyHarness.captureError) {
    if (request?.type === 'status') return { ok: true, value: 'error' }
    if (request?.type === 'begin') return { ok: false, error: { name: 'Error', message: 'Test capture failure' } }
  }
  const result = await listener(event, request)
  if (tracked) record(`response:${request?.type}:${result.ok ? 'ok' : result.error?.name}`)
  if (request?.type === 'wallets.revealBackup' && globalThis.privacyHarness.delay) {
    const fail = await new Promise((resolve) => queued.push(resolve))
    if (fail) return { ok: false, error: { name: 'InvalidPasswordError', message: 'Test failure' } }
  }
  return result
})
require(join(__dirname, '../../out/main/index.js'))
