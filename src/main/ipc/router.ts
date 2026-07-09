import { app, ipcMain } from 'electron'
import { fail, WALLET_CHANNEL, ok, type VaultRequest } from '../../shared/protocol'
import type { VaultOrchestrator } from '../vault/orchestrator'

export interface WalletIpcOptions {
  /** Trust predicate over the sender frame's URL. When provided, a request from
   *  any other frame (or a sub-frame) is refused before it reaches the
   *  orchestrator. Defence-in-depth per Electron's security guidance — with
   *  sandbox + locked-down navigation nothing else should be able to send here,
   *  but IPC is the wallet's entire attack surface, so verify anyway. */
  readonly isTrustedSender?: (frameUrl: string) => boolean
}

// One typed channel for the renderer. `ping` is answered here; every other
// request is a VaultRequest handled by the orchestrator (which wraps the Vault).
// The orchestrator already returns a WalletResponse envelope.
export function registerWalletIpc(orchestrator: VaultOrchestrator, opts: WalletIpcOptions = {}): void {
  ipcMain.handle(WALLET_CHANNEL, async (event, request: unknown) => {
    if (opts.isTrustedSender !== undefined) {
      const frame = event.senderFrame
      // Only the top-level document of a trusted URL may speak: a null frame
      // (already destroyed) or an iframe is refused outright.
      if (frame === null || frame !== event.sender.mainFrame || !opts.isTrustedSender(frame.url)) {
        return fail(new Error('Request refused: untrusted sender.'))
      }
    }
    // Minimal runtime shape check before trusting the compile-time cast: IPC
    // input is external data, whatever the preload types promise.
    if (typeof request !== 'object' || request === null || typeof (request as { type?: unknown }).type !== 'string') {
      return fail(new Error('Malformed wallet request.'))
    }
    if ((request as { type: string }).type === 'ping') {
      return ok({ pong: true as const, version: app.getVersion() })
    }
    return orchestrator.handle(request as VaultRequest)
  })
}
