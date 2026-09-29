import type { IpcMainInvokeEvent } from 'electron'
import { fail, ok, type WalletResponse } from '../../shared/protocol'
import { isPurpose, type PrivacyRequest } from '../../shared/privacy'
import type { SensitiveSessionManager } from './SensitiveSessionManager'

export function trustedDocument(event: IpcMainInvokeEvent, manager: SensitiveSessionManager, isTrustedUrl: (url: string) => boolean): boolean {
  if (typeof isTrustedUrl !== 'function') return false
  const frame = event.senderFrame
  return manager.registered(event.sender.id) && !event.sender.isDestroyed() && frame !== null &&
    frame === event.sender.mainFrame && isTrustedUrl(frame.url)
}

export function handlePrivacy(manager: SensitiveSessionManager, owner: number, data: unknown): WalletResponse<unknown> {
  try {
    if (!data || typeof data !== 'object') throw new Error('Malformed privacy request.')
    const req = data as Partial<PrivacyRequest>
    if (req.type === 'status') return ok(manager.status(owner))
    if (req.type === 'begin' && isPurpose(req.purpose) && typeof req.acknowledged === 'boolean') {
      return ok(manager.begin(owner, req.purpose, req.acknowledged))
    }
    if (req.type === 'cleared') {
      manager.cleared(owner)
      return ok(undefined)
    }
    if (req.type === 'end' && typeof req.sessionId === 'string' && req.sessionId.length > 0) {
      manager.end(owner, req.sessionId)
      return ok(undefined)
    }
    throw new Error('Malformed privacy request.')
  } catch (error) { return fail(error) }
}
