import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AddressAlgo, KeyInspection } from '../../shared/protocol'
import type { SensitiveAccess } from './useSensitiveSession'
import { wallet } from './wallet'

// Cache only the public preview, never an extra copy of the private key. A
// privacy pause preserves the user's algorithm; editing the key invalidates it.
export function useKeyInspection(text: string, enabled: boolean, access: SensitiveAccess, setError: (error: string | null) => void) {
  const normalized = text.trim()
  const cached = useRef<KeyInspection | null>(null)
  const [inspection, setInspection] = useState<KeyInspection | null>(null)
  const [keyAlgo, setKeyAlgo] = useState<AddressAlgo | null>(null)
  useLayoutEffect(() => {
    cached.current = null
    setInspection(null)
    setKeyAlgo(null)
    setError(null)
  }, [normalized, enabled, setError])
  useEffect(() => {
    if (!enabled || !access.active || !normalized || cached.current) return
    const ticket = access.controller.ticket()
    let current = true
    const timer = setTimeout(() => {
      void wallet.inspectKey(normalized).then((result) => {
        if (!current || !access.controller.current(ticket)) return
        cached.current = result
        setInspection(result)
        setKeyAlgo(result.candidates[0] ?? null)
      }).catch((error: unknown) => {
        if (current && access.controller.current(ticket)) setError(error instanceof Error ? error.message : 'Could not inspect this key.')
      })
    }, 300)
    return () => { current = false; clearTimeout(timer) }
  }, [normalized, enabled, access.active, access.controller, setError])
  return { inspection, keyAlgo, setKeyAlgo }
}
