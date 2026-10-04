export const SHOW_CHANGELOG_CHANNEL = 'app:show-changelog' as const

export interface AppNavigationApi {
  /** Native Help menu request. Available before a wallet is created or unlocked. */
  onShowChangelog(listener: () => void): () => void
}
