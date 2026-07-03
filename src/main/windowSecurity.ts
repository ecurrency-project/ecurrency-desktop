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
// the dev-server origin in development, or a file:// URL in a packaged build (what
// loadFile produces). Anything else is a navigation away from the app — blocked.
// The SPA routes client-side (history/hash, which don't fire will-navigate), so in
// practice legitimate navigations are just the initial load.
export function isAppNavigation(url: string, opts: { readonly devUrl?: string }): boolean {
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
  return target.protocol === 'file:'
}
