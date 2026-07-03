// Brand wordmark stub — brand branches replace this with their real artwork.
export function Logo({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="Logo">
      <circle cx="24" cy="24" r="21" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.35" />
      <text x="24" y="29" textAnchor="middle" fontSize="14" fontWeight="600" fill="currentColor" opacity="0.7">
        ¤
      </text>
    </svg>
  )
}
