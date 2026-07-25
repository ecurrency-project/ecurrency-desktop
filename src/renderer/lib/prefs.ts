import { useCallback, useSyncExternalStore } from 'react'

// User-facing display preferences — not chain data, not secrets. Persisted to
// localStorage so they survive restarts, and exposed as a tiny external store so
// any screen reacts live. Currently just "advanced mode", which unlocks the
// Sparrow-style technical detail (scripts, signatures, outpoints, raw hex) in the
// transaction drawer; off by default for a clean, consumer-friendly view.

type Listener = () => void

const ADVANCED_KEY = 'wallet.advancedMode'

function readAdvanced(): boolean {
  try {
    return window.localStorage.getItem(ADVANCED_KEY) === '1'
  } catch {
    return false
  }
}

let advanced = readAdvanced()
const listeners = new Set<Listener>()

// Toggle advanced mode and persist it. A no-op when unchanged so we don't wake
// subscribers needlessly.
export function setAdvancedMode(value: boolean): void {
  if (value === advanced) return
  advanced = value
  try {
    window.localStorage.setItem(ADVANCED_KEY, value ? '1' : '0')
  } catch {
    // Non-fatal: the preference just won't persist across restarts.
  }
  for (const l of [...listeners]) l()
}

// Subscribe a component to the advanced-mode flag (re-renders on toggle).
export function useAdvancedMode(): boolean {
  const sub = useCallback((l: Listener) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }, [])
  return useSyncExternalStore(sub, () => advanced, () => advanced)
}

// ── Theme ────────────────────────────────────────────────────────────
// Dark by default (the app's own look), light when the user picks it.
// Persisted like advanced mode so a restart doesn't undo the choice.

export type Theme = 'dark' | 'light'

const THEME_KEY = 'wallet.theme'

function readTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

let theme = readTheme()
const themeListeners = new Set<Listener>()

export function setTheme(value: Theme): void {
  if (value === theme) return
  theme = value
  try {
    window.localStorage.setItem(THEME_KEY, value)
  } catch {
    // Non-fatal: the preference just won't persist across restarts.
  }
  for (const l of [...themeListeners]) l()
}

export function useTheme(): Theme {
  const sub = useCallback((l: Listener) => {
    themeListeners.add(l)
    return () => themeListeners.delete(l)
  }, [])
  return useSyncExternalStore(sub, () => theme, () => theme)
}
