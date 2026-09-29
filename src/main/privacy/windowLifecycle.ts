import type { BrowserWindow } from 'electron'
import { PRIVACY_EVENT_CHANNEL } from '../../shared/privacy'
import type { SensitiveSessionManager } from './SensitiveSessionManager'
import { createCaptureShield } from './captureProtection'

export function protectSensitiveWindow(win: BrowserWindow, sessions: SensitiveSessionManager, lockVault: () => void, cancelSensitiveScan: (sessionId: string) => void, onRecoveryFailed: () => void, platform: string = process.platform): () => void {
  const contents = win.webContents
  const owner = contents.id
  const shield = createCaptureShield(win, platform)
  let unsafeFrame = false
  let recovering = false
  sessions.register(owner, {
    available: () => !win.isDestroyed() && !unsafeFrame && win.isVisible() && win.isFocused() && !win.isMinimized(),
    captureStatus: () => shield.status,
    engageShield: () => !win.isDestroyed() && shield.engage(),
    shieldIntact: () => !win.isDestroyed() && shield.intact(),
    // A frozen or crashed renderer may still show its last secret frame; only a
    // fresh document may report the screen clean.
    releaseShield: () => { if (!win.isDestroyed() && !unsafeFrame) shield.release() },
    notify: (event) => {
      cancelSensitiveScan(event.sessionId)
      if (!contents.isDestroyed()) contents.send(PRIVACY_EVENT_CHANNEL, event)
    },
  })
  win.on('blur', () => sessions.revoke(owner, 'blur'))
  win.on('hide', () => sessions.revoke(owner, 'hidden'))
  win.on('minimize', () => sessions.revoke(owner, 'hidden'))
  contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame) {
      sessions.navigate(owner)
      if (!inPlace) lockVault()
    }
  })
  const quarantine = (): void => {
    // A prior blur may already have revoked the permission while the frozen
    // renderer still displays its last secret frame. Quarantine even then.
    unsafeFrame = true
    sessions.revoke(owner, 'unresponsive')
    win.hide()
    lockVault()
  }
  win.on('unresponsive', quarantine)
  contents.on('render-process-gone', () => {
    const failedRecovery = recovering
    recovering = false
    quarantine()
    sessions.navigate(owner)
    // One automatic attempt; repeated crashes need an explicit retry, avoiding
    // an endless crash/reload loop with an invisible window.
    if (failedRecovery) onRecoveryFailed()
    else showSafe()
  })
  const showSafe = (): void => {
    if (win.isDestroyed() || contents.isDestroyed()) return
    if (unsafeFrame) {
      if (!recovering) {
        recovering = true
        try { contents.reload() }
        catch { recovering = false; onRecoveryFailed() }
      }
    } else { win.show() }
  }
  win.on('responsive', () => { if (unsafeFrame) showSafe() })
  win.on('show', () => { if (unsafeFrame) win.hide() })
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !recovering) return
    recovering = false
    onRecoveryFailed()
  })
  contents.on('did-finish-load', () => {
    if (recovering) {
      recovering = false
      unsafeFrame = false
      win.show()
    }
  })
  win.on('closed', () => { sessions.remove(owner); lockVault() })
  return showSafe
}
