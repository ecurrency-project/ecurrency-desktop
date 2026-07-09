import { describe, expect, it } from 'vitest'
import { isAppNavigation, isSafeExternalUrl } from '../../src/main/windowSecurity'

describe('isSafeExternalUrl', () => {
  it('allows https links', () => {
    expect(isSafeExternalUrl('https://explorer.example.org/tx/abc123')).toBe(true)
    expect(isSafeExternalUrl('https://example.org')).toBe(true)
  })

  it('refuses http and any non-https scheme', () => {
    expect(isSafeExternalUrl('http://evil.test')).toBe(false)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('coin://pay?to=x')).toBe(false)
    expect(isSafeExternalUrl('smb://host/share')).toBe(false)
    expect(isSafeExternalUrl('mailto:a@b.test')).toBe(false)
  })

  it('refuses unparseable input', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
  })
})

describe('isAppNavigation', () => {
  it('dev: allows only the dev-server origin', () => {
    const devUrl = 'http://localhost:5173'
    expect(isAppNavigation('http://localhost:5173/', { devUrl })).toBe(true)
    expect(isAppNavigation('http://localhost:5173/wallet', { devUrl })).toBe(true)
    expect(isAppNavigation('http://localhost:6006/', { devUrl })).toBe(false)
    expect(isAppNavigation('https://evil.test/', { devUrl })).toBe(false)
    expect(isAppNavigation('file:///somewhere/index.html', { devUrl })).toBe(false)
  })

  it('prod (no devUrl): allows only file:// URLs', () => {
    expect(isAppNavigation('file:///Applications/Wallet.app/Contents/Resources/app/renderer/index.html', {})).toBe(true)
    expect(isAppNavigation('https://evil.test/', {})).toBe(false)
    expect(isAppNavigation('http://localhost:5173/', {})).toBe(false)
    expect(isAppNavigation('javascript:alert(1)', {})).toBe(false)
  })

  it('prod with appFileUrl: allows EXACTLY the bundled index.html, no other local file', () => {
    const appFileUrl = 'file:///Applications/Wallet.app/Contents/Resources/app/renderer/index.html'
    expect(isAppNavigation(appFileUrl, { appFileUrl })).toBe(true)
    // Query/hash on the same document are fine (loadFile can append them).
    expect(isAppNavigation(`${appFileUrl}#route`, { appFileUrl })).toBe(true)
    expect(isAppNavigation(`${appFileUrl}?x=1`, { appFileUrl })).toBe(true)
    // Any OTHER local file is a navigation away from the app.
    expect(isAppNavigation('file:///etc/passwd', { appFileUrl })).toBe(false)
    expect(isAppNavigation('file:///Applications/Wallet.app/Contents/Resources/app/renderer/other.html', { appFileUrl })).toBe(false)
    expect(isAppNavigation('https://evil.test/', { appFileUrl })).toBe(false)
  })

  it('refuses unparseable input', () => {
    expect(isAppNavigation('::::', {})).toBe(false)
    expect(isAppNavigation('', { devUrl: 'http://localhost:5173' })).toBe(false)
  })
})
