import { app, ipcMain } from 'electron'
import { fail, WALLET_CHANNEL, ok, type VaultRequest, type VaultStatus } from '../../shared/protocol'
import { PRIVACY_CHANNEL, SensitiveSessionError } from '../../shared/privacy'
import { handlePrivacy, trustedDocument } from '../privacy/ipc'
import type { SensitiveSessionManager } from '../privacy/SensitiveSessionManager'
import type { VaultOrchestrator } from '../vault/orchestrator'

export interface WalletIpcOptions {
  readonly isTrustedSender: (frameUrl: string) => boolean
  readonly sessions: SensitiveSessionManager
  readonly getVaultStatus: () => VaultStatus | Promise<VaultStatus>
}

export function registerWalletIpc(orchestrator: VaultOrchestrator, opts: WalletIpcOptions): void {
  const { sessions } = opts
  const pending = new Set<string>()
  ipcMain.handle(PRIVACY_CHANNEL, (event, request: unknown) => {
    if (!trustedDocument(event, sessions, opts.isTrustedSender)) return fail(new Error('Request refused: untrusted sender.'))
    return handlePrivacy(sessions, event.sender.id, request)
  })
  ipcMain.handle(WALLET_CHANNEL, async (event, request: unknown) => {
    let pendingId: string | undefined
    try {
      if (!trustedDocument(event, sessions, opts.isTrustedSender)) throw new Error('Request refused: untrusted sender.')
      if (typeof request !== 'object' || request === null || typeof (request as { type?: unknown }).type !== 'string') {
        throw new Error('Malformed wallet request.')
      }
      const req = request as VaultRequest | { type: 'ping' }
      if (req.type === 'ping') return ok({ pong: true as const, version: app.getVersion() })
      const owner = event.sender.id
      if (req.type === 'vault.revealMnemonic' || req.type === 'vault.generateMnemonic' || req.type === 'sweep.scan') {
        if (typeof req.sessionId !== 'string' || !req.sessionId || (req.type === 'vault.revealMnemonic' && typeof req.password !== 'string') || (req.type === 'sweep.scan' && typeof req.wif !== 'string')) {
          throw new Error('Malformed sensitive request.')
        }
        const purpose = req.type === 'vault.revealMnemonic' ? 'reveal' : req.type === 'sweep.scan' ? 'key-input' : 'onboarding'
        sessions.assert(owner, req.sessionId, purpose)
        if (pending.has(req.sessionId)) throw new SensitiveSessionError()
        pendingId = req.sessionId
        pending.add(pendingId)
        const frame = event.senderFrame
        const generation = sessions.generation(owner)
        if (purpose === 'reveal' && await opts.getVaultStatus() !== 'unlocked') throw new SensitiveSessionError()
        sessions.assert(owner, req.sessionId, purpose)
        const response = await orchestrator.handle(req)
        // A successful KDF must not resurrect permission lost while it ran.
        try {
          if (!trustedDocument(event, sessions, opts.isTrustedSender) || frame !== event.sender.mainFrame || generation !== sessions.generation(owner)) {
            throw new SensitiveSessionError()
          }
          sessions.assert(owner, req.sessionId, purpose)
        } catch (error) {
          if (req.type === 'sweep.scan') await orchestrator.handle({ type: 'sweep.cancel', sessionId: req.sessionId })
          throw error
        }
        return response
      }
      if (req.type === 'sweep.cancel' && (typeof req.sessionId !== 'string' || !req.sessionId)) throw new Error('Malformed sweep cancellation.')
      if (['vault.lock', 'vault.destroy', 'vault.create', 'wallets.restore', 'wallets.switch', 'wallets.remove', 'network.set'].includes(req.type)) {
        sessions.revokeAll('context')
      }
      return await orchestrator.handle(req)
    } catch (error) { return fail(error) }
    finally { if (pendingId !== undefined) pending.delete(pendingId) }
  })
}
