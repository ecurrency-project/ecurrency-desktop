import { app, ipcMain } from 'electron'
import { WALLET_CHANNEL, ok, type VaultRequest } from '../../shared/protocol'
import type { VaultOrchestrator } from '../vault/orchestrator'

// One typed channel for the renderer. `ping` is answered here; every other
// request is a VaultRequest handled by the orchestrator (which wraps the Vault).
// The orchestrator already returns a WalletResponse envelope.
export function registerWalletIpc(orchestrator: VaultOrchestrator): void {
  ipcMain.handle(WALLET_CHANNEL, async (_event, request: { readonly type: string }) => {
    if (request.type === 'ping') {
      return ok({ pong: true as const, version: app.getVersion() })
    }
    return orchestrator.handle(request as VaultRequest)
  })
}
