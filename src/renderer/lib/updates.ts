import { useSyncExternalStore } from 'react'
import type { UpdateEvent } from '../../shared/protocol'

// Mirror of the main-process auto-update lifecycle. We subscribe to window.updater
// once at module load — before any component mounts — so an event can't slip
// through before the banner is listening. Components read the latest event via the
// hook below.
let current: UpdateEvent | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

window.updater.onEvent((event) => {
  current = event
  emit()
})

export function useUpdateStatus(): UpdateEvent | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
    () => current,
  )
}

// Apply the downloaded update now (quit + relaunch into the new version).
export function restartToInstall(): void {
  window.updater.restartToInstall()
}

// Dismiss the current banner for this session. The update still installs on the
// next quit (autoInstallOnAppQuit), so nothing is lost.
export function dismissUpdate(): void {
  current = null
  emit()
}
