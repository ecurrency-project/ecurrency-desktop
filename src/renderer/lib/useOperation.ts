import { useLayoutEffect, useRef, useState } from 'react'

// Mutations may finish after privacy is revoked. Keep them single-flight until
// their public outcome is known; never interpret hiding as a rollback or retry.
export function useOperation() {
  const mounted = useRef(true)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  return {
    busy,
    pending,
    current: () => mounted.current,
    start: () => {
      if (!mounted.current || pending.current) return false
      pending.current = true
      setBusy(true)
      return true
    },
    finish: () => {
      pending.current = false
      if (mounted.current) setBusy(false)
    },
  }
}
