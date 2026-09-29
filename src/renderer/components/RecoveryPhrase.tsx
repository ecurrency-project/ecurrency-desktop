import { preventSecretExport } from './SensitiveContent'

export function RecoveryPhrase({ words, shown }: { words: readonly string[]; shown: boolean }) {
  return (
    <div role="group" aria-label={shown ? 'Recovery phrase' : 'Recovery phrase hidden'} {...preventSecretExport}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12, userSelect: 'none' }}>
      {Array.from({ length: words.length || 12 }, (_, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--well)' }}>
          <span style={{ fontSize: 11, color: 'var(--ink-300)' }}>{i + 1}</span>
          <span data-testid={shown ? 'seed-word' : 'seed-placeholder'} style={{ fontSize: 13.5, fontFamily: 'var(--mono)', color: 'var(--ink-900)' }}>{shown ? words[i] : '••••••'}</span>
        </div>
      ))}
    </div>
  )
}
