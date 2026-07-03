// Heuristic password strength: length tiers plus a character-variety check. This
// drives the meter only; the create flow gates on length + match, not on score.
export function passwordStrength(pw: string): { score: number; label: string } {
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (/[^A-Za-z0-9]/.test(pw) || (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw))) score++
  if (pw.length >= 16) score++
  return { score, label: ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][score] ?? 'Weak' }
}

// Tone tiers: weak → danger, fair → warning, good/strong → success.
function toneFor(score: number): 'danger' | 'warning' | 'success' {
  return score <= 1 ? 'danger' : score === 2 ? 'warning' : 'success'
}

export function PasswordStrength({ password }: { password: string }) {
  if (password.length === 0) return null
  const { score, label } = passwordStrength(password)
  const tone = toneFor(score)
  return (
    <div className="pwstrength">
      <div className="pwstrength-bars">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="pwstrength-bar" data-on={i < score ? 'true' : undefined} data-tone={tone} />
        ))}
      </div>
      <span className="pwstrength-label" data-tone={tone}>
        {label}
      </span>
    </div>
  )
}
