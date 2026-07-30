// Token avatars. Well-known tokens get a full-colour brand logo (raw SVG, unlike
// the monochrome UI icon set); any other token falls back to a letter on a colour
// derived from its id, so it stays stable and distinct. Decorative — the
// surrounding row carries the token's name/symbol as text.

// Keyed by uppercased symbol OR name (the node sometimes labels USDT as name="USDT"
// with symbol="Tether USD", so both are checked).
const BRAND: Record<string, string> = {
  USDT: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 32 32" aria-hidden="true"><g fill="none" fill-rule="evenodd"><circle cx="16" cy="16" r="16" fill="#26A17B"/><path fill="#FFF" d="M17.922 17.383v-.002c-.11.008-.677.042-1.942.042-1.01 0-1.721-.03-1.971-.042v.003c-3.888-.171-6.79-.848-6.79-1.658 0-.809 2.902-1.486 6.79-1.66v2.644c.254.018.982.061 1.988.061 1.207 0 1.812-.05 1.925-.06v-2.643c3.88.173 6.775.85 6.775 1.658 0 .81-2.895 1.485-6.775 1.657m0-3.59v-2.366h5.414V7.819H8.595v3.608h5.414v2.365c-4.4.202-7.709 1.074-7.709 2.118 0 1.044 3.309 1.915 7.709 2.118v7.582h3.913v-7.584c4.393-.202 7.694-1.073 7.694-2.116 0-1.043-3.301-1.914-7.694-2.117"/></g></svg>',
}

const PALETTE: readonly { bg: string; fg: string }[] = [
  { bg: 'var(--primary-soft)', fg: 'var(--primary)' },
  { bg: 'color-mix(in srgb, var(--success) 16%, transparent)', fg: 'var(--success)' },
  { bg: 'var(--pq-soft)', fg: 'var(--pq)' },
  { bg: 'color-mix(in srgb, var(--warning) 16%, transparent)', fg: 'var(--warning)' },
]

function paletteFor(id: string): { bg: string; fg: string } {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]!
}

export interface TokenGlyphInput {
  readonly id: string
  readonly symbol?: string
  readonly name?: string
}

export function TokenGlyph({ token, size = 34 }: { token: TokenGlyphInput; size?: number }) {
  const brand = BRAND[(token.symbol ?? '').toUpperCase()] ?? BRAND[(token.name ?? '').toUpperCase()]
  if (brand !== undefined) {
    return <span style={{ width: size, height: size, flex: 'none', display: 'inline-flex' }} dangerouslySetInnerHTML={{ __html: brand }} />
  }
  const { bg, fg } = paletteFor(token.id)
  const letter = (token.symbol ?? token.name ?? '?').slice(0, 1).toUpperCase()
  return (
    <span style={{ width: size, height: size, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: Math.round(size * 0.38), background: bg, color: fg }}>
      {letter}
    </span>
  )
}
