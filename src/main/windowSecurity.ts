// Window/navigation hardening predicates.
//
// Kept pure (no Electron, no I/O) so they're unit-testable; the wiring that
// applies them to every webContents lives in index.ts. Two complementary guards:
//
//   • isSafeExternalUrl — what may be handed to the OS browser via shell.openExternal
//   • isAppNavigation   — what the window itself may navigate to
//
// Defence-in-depth on top of sandbox + contextIsolation + CSP: even a renderer
// compromise or a crafted link shouldn't be able to launch arbitrary OS handlers
// or steer the window onto a foreign (phishing/exploit) origin.

export function rendererDevUrl(isPackaged: boolean, envUrl: string | undefined): string | undefined {
  return isPackaged ? undefined : envUrl
}

// IPC trusts a single document, including its query, never an entire origin.
export function isTrustedRendererDocument(url: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(url)
    const expected = new URL(expectedUrl)
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname && actual.search === expected.search
  } catch { return false }
}

// Only https links may be opened externally. Everything else — file:,
// javascript:, mailto:, custom protocol handlers, even http: — is refused, so a
// crafted or injected link can't invoke arbitrary OS handlers. Unparseable input
// is refused too.
export function isSafeExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

// True only for the app's OWN content, which the window is allowed to navigate to:
// the dev-server origin in development, or — in a packaged build — EXACTLY the
// file:// URL of the bundled index.html (`appFileUrl`, what loadFile produces).
// Anything else is a navigation away from the app — blocked: a blanket `file:`
// allowance would let a compromised renderer steer the window onto any local
// file. Without an `appFileUrl` (not wired), prod falls back to file:-only.
// The SPA routes client-side (history/hash, which don't fire will-navigate), so in
// practice legitimate navigations are just the initial load.
export function isAppNavigation(url: string, opts: { readonly devUrl?: string; readonly appFileUrl?: string }): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (opts.devUrl !== undefined) {
    try {
      return target.origin === new URL(opts.devUrl).origin
    } catch {
      return false
    }
  }
  if (target.protocol !== 'file:') return false
  if (opts.appFileUrl === undefined) return true
  try {
    // Compare pathnames (URL-normalized), ignoring ?query/#hash on the target.
    return target.pathname === new URL(opts.appFileUrl).pathname
  } catch {
    return false
  }
}
