export const PRIVACY_CHANNEL = 'privacy:request'
export const PRIVACY_EVENT_CHANNEL = 'privacy:revoked'
export const SENSITIVE_SESSION_MS = 120_000

export type CaptureStatus = 'best-effort' | 'limited' | 'unsupported' | 'error'
export type SensitivePurpose = 'reveal' | 'onboarding' | 'seed-input' | 'key-input' | 'confirmation'
export type RevokeReason = 'ended' | 'replaced' | 'blur' | 'hidden' | 'expired' | 'navigation' | 'unresponsive' | 'destroyed' | 'locked' | 'context' | 'suspend'
export interface SensitiveSession {
  readonly sessionId: string
  readonly deadline: number
}
export interface SessionRevoked {
  readonly sessionId: string
  readonly reason: RevokeReason
}
export type PrivacyRequest =
  | { readonly type: 'status' }
  | { readonly type: 'begin'; readonly purpose: SensitivePurpose; readonly acknowledged: boolean }
  | { readonly type: 'end'; readonly sessionId: string }
  | { readonly type: 'cleared' }
export interface PrivacyApi {
  getCaptureStatus(): Promise<CaptureStatus>
  begin(purpose: SensitivePurpose, acknowledged: boolean): Promise<SensitiveSession>
  end(sessionId: string): Promise<void>
  /** The renderer painted a frame without any secret; main may lift capture protection. */
  cleared(): Promise<void>
  onRevoked(listener: (event: SessionRevoked) => void): () => void
}
export function isPurpose(value: unknown): value is SensitivePurpose {
  return ['reveal', 'onboarding', 'seed-input', 'key-input', 'confirmation'].includes(value as string)
}
export class SensitiveSessionError extends Error {
  override name = 'SensitiveSessionError'
  constructor() { super('Sensitive session ended. Continue explicitly to try again.') }
}
