import type { ReactNode } from 'react'

export interface SegmentedOption<T extends string> {
  readonly value: T
  readonly label: ReactNode
}

// Single-select segmented control on a --well track; the active segment lifts to
// --card. Generic over the option value union for type-safe onChange.
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className="segmented-btn"
          data-active={o.value === value ? 'true' : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
