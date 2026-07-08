import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { UPDATE_EVENT_CHANNEL, UPDATE_INSTALL_CHANNEL, type UpdateEvent } from '../shared/protocol'
import { PRODUCT_NAME } from './appInfo'

// Auto-update via electron-updater against the generic HTTPS feed configured in
// electron-builder.yml (publish: generic → the brand's download URL).
//
// Trust model: an update is applied only because the artifacts are code-signed
// (macOS Developer ID + notarization; Windows Authenticode) and electron-updater
// verifies the SHA512 from latest-*.yml fetched over HTTPS. Never point this at a
// plain-http feed.
//
// The lifecycle is pushed to the renderer (in-app banner) over UPDATE_EVENT_CHANNEL;
// the renderer asks to apply it over UPDATE_INSTALL_CHANNEL. Runs only in packaged
// builds — dev is skipped. A missing/empty feed or offline is non-fatal (logged).
function broadcast(event: UpdateEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(UPDATE_EVENT_CHANNEL, event)
  }
}

export function initAutoUpdater(): void {
  // The renderer may ask to install even in dev (no-op there); register always.
  ipcMain.on(UPDATE_INSTALL_CHANNEL, () => autoUpdater.quitAndInstall())

  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => broadcast({ kind: 'available', version: info.version }))
  autoUpdater.on('download-progress', (p) => broadcast({ kind: 'progress', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => broadcast({ kind: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => broadcast({ kind: 'error', message: err.message }))

  void autoUpdater.checkForUpdates().catch((err: unknown) => {
    console.error('Update check failed:', err)
  })
}

/**
 * Manual "Check for Updates…" from the menu: same updater, but the outcome
 * is answered with a dialog. Download still happens in the background and
 * the in-app banner (broadcast above) offers the restart.
 */
export async function checkForUpdatesInteractive(): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: PRODUCT_NAME,
      message: 'Updates are only available in packaged builds.',
      buttons: ['OK'],
    })
    return
  }
  try {
    const outcome = await new Promise<{ available: boolean; version?: string }>((resolve, reject) => {
      const cleanup = (): void => {
        autoUpdater.off('update-available', onAvailable)
        autoUpdater.off('update-not-available', onNone)
        autoUpdater.off('error', onError)
      }
      const onAvailable = (info: { version: string }): void => {
        cleanup()
        resolve({ available: true, version: info.version })
      }
      const onNone = (): void => {
        cleanup()
        resolve({ available: false })
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      autoUpdater.on('update-available', onAvailable)
      autoUpdater.on('update-not-available', onNone)
      autoUpdater.on('error', onError)
      autoUpdater.checkForUpdates().catch(onError)
    })
    if (outcome.available) {
      await dialog.showMessageBox({
        type: 'info',
        title: PRODUCT_NAME,
        message: `Version ${outcome.version ?? ''} is available.`,
        detail: 'It is downloading in the background — the app will offer to restart when it is ready.',
        buttons: ['OK'],
      })
    } else {
      await dialog.showMessageBox({
        type: 'info',
        title: PRODUCT_NAME,
        message: `You're up to date.`,
        detail: `${PRODUCT_NAME} ${app.getVersion()} is the latest version.`,
        buttons: ['OK'],
      })
    }
  } catch (err) {
    dialog.showErrorBox(PRODUCT_NAME, `Update check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
