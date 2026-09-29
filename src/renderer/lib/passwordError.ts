export function passwordError(error: unknown): string {
  if (!(error instanceof Error)) return 'Could not check the password. Try again.'
  if (error.name === 'UnlockThrottledError') {
    const retry = (error as Error & { retryAfterMs?: number }).retryAfterMs
    return typeof retry === 'number' && Number.isFinite(retry)
      ? `Too many attempts. Try again in ${Math.max(1, Math.ceil(retry / 1000))} ${retry <= 1000 ? 'second' : 'seconds'}.` : error.message
  }
  if (error.name === 'SensitiveSessionError' || error.name === 'WalletLockedError') return 'Session ended. Continue and enter your password again.'
  if (error.name === 'InvalidPasswordError') return 'Incorrect password — try again.'
  return 'Could not check the password. Try again.'
}
