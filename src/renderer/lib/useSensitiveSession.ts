import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import type { SensitivePurpose } from '../../shared/privacy'
import { SensitiveSessionController } from './sensitiveSession'
import { privacy } from './privacy'

export function useSensitiveSession(purpose: SensitivePurpose, enabled = true, onHide?: (reason: string) => void) {
  const hideRef = useRef(onHide)
  hideRef.current = onHide
  const [controller] = useState(() => new SensitiveSessionController(
    privacy,
    () => document.visibilityState === 'visible' && document.hasFocus(),
    (reason) => hideRef.current?.(reason),
  ))
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useLayoutEffect(() => {
    if (!enabled) return undefined
    controller.enable()
    const hide = (): void => { flushSync(() => controller.stop('blur')) }
    const visibility = (): void => { if (document.visibilityState !== 'visible') hide() }
    const checkDeadline = (): void => {
      if (controller.snapshot().session && !controller.ticket()) hide()
    }
    window.addEventListener('blur', hide)
    window.addEventListener('focus', checkDeadline)
    document.addEventListener('visibilitychange', visibility)
    const off = privacy.onRevoked((event) => flushSync(() => controller.revoke(event)))
    return () => {
      window.removeEventListener('blur', hide)
      window.removeEventListener('focus', checkDeadline)
      document.removeEventListener('visibilitychange', visibility)
      off()
      controller.disable()
    }
  }, [controller, enabled, purpose])
  return { ...state, controller, active: enabled && state.session !== null, begin: () => controller.begin(purpose) }
}
export type SensitiveAccess = ReturnType<typeof useSensitiveSession>
