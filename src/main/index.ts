import { join } from 'node:path'
import { app, BrowserWindow, Menu, session, shell, type WebContents } from 'electron'
import { setSchnorrEnabled } from '@qbitcoin/crypto'
import { WALLET_EVENT_CHANNEL, type VaultStatus } from '../shared/protocol'
import { registerWalletIpc } from './ipc/router'
import { buildAppMenu } from './menu'
import { createWalletCore } from './vault'
import { configureFalconWasm } from './wallet/falconWasm'
import { initAutoUpdater } from './updater'
import { isAppNavigation, isSafeExternalUrl } from './windowSecurity'

// electron-vite sets this only while running `dev` (renderer served with HMR).
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']
const isDev = rendererDevUrl !== undefined

// Packaged builds load the renderer from file:// — pin a strict CSP there. Dev
// stays open so the Vite dev server and HMR work. The real boundary is the
// webPreferences below; full hardening is a later phase.
function applyProductionCsp(): void {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        ],
      },
    })
  })
}

// Lock down every webContents (the main window and anything created later): new
// windows / window.open go to the OS browser (https only) and never open in-app,
// and the frame can't navigate away from the app's own content. CSP + sandbox +
// contextIsolation are the primary controls; these close the navigation surface.
function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppNavigation(url, { devUrl: rendererDevUrl })) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
}

function createWindow(): void {
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
    },
  })

  win.once('ready-to-show', () => win.show())

  if (rendererDevUrl !== undefined) {
    void win.loadURL(rendererDevUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
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
    const { vault, orchestrator } = createWalletCore()
    registerWalletIpc(orchestrator)

    // Push status changes to the renderer (notably an autolock 'timeout' lock),
    // so the UI can return to the lock screen without polling.
    vault.on((event) => {
      const status: VaultStatus =
        event.type === 'locked' ? 'locked' : event.type === 'destroyed' ? 'empty' : 'unlocked'
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(WALLET_EVENT_CHANNEL, status)
      }
    })

    createWindow()

    // Check for updates against the generic HTTPS feed (packaged builds only).
    // The lifecycle is pushed to the renderer for an in-app banner (see updater.ts).
    initAutoUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((err: unknown) => {
    console.error('Failed to start the wallet:', err)
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
