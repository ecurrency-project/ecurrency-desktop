import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, Menu, powerMonitor, session, shell, type WebContents } from 'electron'
import { setSchnorrEnabled } from '@qbtc/crypto'
import { PRODUCTION_CSP } from '../shared/csp'
import { WALLET_EVENT_CHANNEL, type VaultStatus } from '../shared/protocol'
import { SensitiveSessionManager } from './privacy/SensitiveSessionManager'
import { protectSensitiveWindow } from './privacy/windowLifecycle'
import { registerWalletIpc } from './ipc/router'
import { buildAppMenu } from './menu'
import { createWalletCore } from './vault'
import { configureFalconWasm } from './wallet/falconWasm'
import { initAutoUpdater } from './updater'
import { isAppNavigation, isSafeExternalUrl, isTrustedRendererDocument, rendererDevUrl as getRendererDevUrl } from './windowSecurity'

// electron-vite sets this only while running `dev` (renderer served with HMR).
const rendererDevUrl = getRendererDevUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL'])
const sensitiveSessions = new SensitiveSessionManager()
const showWindows = new Map<number, () => void>()
const isDev = rendererDevUrl !== undefined

// The bundled renderer entry — the ONLY file:// URL the window may show, and the
// only IPC sender main will answer (see hardenWebContents / trustedIpcSender).
const rendererIndex = join(__dirname, '../renderer/index.html')
const appFileUrl = pathToFileURL(rendererIndex).href

// Packaged builds pin a strict CSP header. For the file://-loaded renderer the
// authoritative copy is the <meta> tag baked into index.html at build time
// (see electron.vite.config.ts — headers don't reliably apply to file://); this
// header covers any http(s) content in the session. Dev stays open so the Vite
// dev server and HMR work; the real boundary is the webPreferences below.
function applyProductionCsp(): void {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [PRODUCTION_CSP],
      },
    })
  })
}

// Lock down every webContents (the main window and anything created later): new
// windows / window.open go to the OS browser (https only) and never open in-app,
// and the frame can't navigate away from the app's own content — in prod that
// means exactly the bundled index.html, not just any file:// URL. CSP + sandbox +
// contextIsolation are the primary controls; these close the navigation surface.
function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppNavigation(url, { devUrl: rendererDevUrl, appFileUrl })) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
}

// Only the current top-level document of the registered window may use IPC.
const trustedIpcSender = (frameUrl: string): boolean => isTrustedRendererDocument(frameUrl, rendererDevUrl ?? appFileUrl)

function createWindow(lockVault: () => void, cancelSensitiveScan: (sessionId: string) => void): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The security boundary: the renderer gets no Node and no Electron internals.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  })

  let recoveryPrompt = false
  const showSafe = protectSensitiveWindow(win, sensitiveSessions, lockVault, cancelSensitiveScan, () => {
    if (recoveryPrompt || win.isDestroyed()) return
    recoveryPrompt = true
    void dialog.showMessageBox({
      type: 'error', message: 'The wallet window could not recover.',
      detail: 'Your wallet is locked. Retry opening the window or close the application.',
      buttons: ['Retry', 'Close'], defaultId: 0, cancelId: 1,
    }).then(({ response }) => {
      recoveryPrompt = false
      if (win.isDestroyed()) return
      if (response === 0) showSafe()
      else win.close()
    }).catch(() => { recoveryPrompt = false; if (!win.isDestroyed()) win.close() })
  })
  showWindows.set(win.id, showSafe)
  win.on('closed', () => showWindows.delete(win.id))
  win.once('ready-to-show', showSafe)

  if (rendererDevUrl !== undefined) {
    void win.loadURL(rendererDevUrl)
  } else {
    void win.loadFile(rendererIndex)
  }
}

app
  .whenReady()
  .then(() => {
    applyProductionCsp()

    // Brand-labelled application menu (the default one would show the raw
    // package name in About/Hide/Quit items).
    Menu.setApplicationMenu(buildAppMenu())

    // Apply window/navigation hardening to every webContents. Registered before
    // any window exists so it catches the main window's contents too.
    app.on('web-contents-created', (_event, contents) => hardenWebContents(contents))

    // Point the Falcon-512 loader at the .wasm bytes (bundled main can't use the
    // package's own relative loader). Safe to call before any PQ derivation/signing.
    configureFalconWasm()

    // Enable Schnorr (BIP-340) signing. The implementation shipped behind this
    // flag; it is turned on now that the node's Schnorr module is confirmed
    // BIP-340-compliant against the shared vectors.
    // Verification was never gated — only signing / offering Schnorr at import.
    setSchnorrEnabled(true)

    // The Vault lives here, in main — sole owner of the decrypted seed.
    const { vault, orchestrator, cancelSensitiveScan } = createWalletCore()
    registerWalletIpc(orchestrator, { isTrustedSender: trustedIpcSender, sessions: sensitiveSessions, getVaultStatus: () => vault.getStatus() })
    const lockVault = (): void => { vault.lock() }
    const suspend = (): void => { sensitiveSessions.revokeAll('suspend'); lockVault() }
    powerMonitor.on('suspend', suspend)
    powerMonitor.on('lock-screen', suspend)
    powerMonitor.on('user-did-resign-active', suspend)

    // Push status changes to the renderer (notably an autolock 'timeout' lock),
    // so the UI can return to the lock screen without polling.
    vault.on((event) => {
      if (event.type === 'locked' || event.type === 'destroyed') sensitiveSessions.revokeAll('locked')
      const status: VaultStatus =
        event.type === 'locked' ? 'locked' : event.type === 'destroyed' ? 'empty' : 'unlocked'
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(WALLET_EVENT_CHANNEL, status)
      }
    })

    createWindow(lockVault, cancelSensitiveScan)

    // Check for updates against the generic HTTPS feed (packaged builds only).
    // The lifecycle is pushed to the renderer for an in-app banner (see updater.ts).
    initAutoUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(lockVault, cancelSensitiveScan)
      else for (const showSafe of showWindows.values()) showSafe()
    })
  })
  .catch((err: unknown) => {
    console.error('Failed to start the wallet:', err)
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
