import { useState, type CSSProperties } from 'react'

/**
 * Click/Enter-to-copy text. The DOM carries the FULL value (title shows it
 * too), so hover reveals it and a click never copies a shortened display
 * string; a brief "Copied" flash confirms. Shared by the tx drawer's
 * identifiers and the Convert flow's txids.
 */
export function CopyValue({ text, display, style }: { text: string; display?: string; style?: CSSProperties }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <span
      role="button"
      tabIndex={0}
      title={copied ? 'Copied' : `${text}\n(click to copy)`}
      onClick={copy}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          copy()
        }
      }}
      style={{ ...style, cursor: 'pointer', color: copied ? 'var(--success)' : style?.color }}
    >
      {copied ? 'Copied' : (display ?? text)}
    </span>
  )
}
