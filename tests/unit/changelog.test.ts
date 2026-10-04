import { describe, expect, it } from 'vitest'
import { parseChangelog } from '../../src/shared/changelog'

describe('bundled release notes', () => {
  it('preserves separate releases and wrapped Markdown paragraphs and bullets', () => {
    const notes = parseChangelog(`# Changelog

## 2.0.0 — 2026-09-29

An introductory paragraph
that wraps onto another line.

### Improvements

- **A useful change.** With a
  wrapped explanation.
- Another change.

A separate closing note.

## 1.9.0 — 2026-08-01

- Previous release.
`)
    expect(notes.map(({ version, date }) => ({ version, date }))).toEqual([
      { version: '2.0.0', date: '2026-09-29' },
      { version: '1.9.0', date: '2026-08-01' },
    ])
    expect(notes[0].blocks).toEqual([
      { kind: 'paragraph', text: 'An introductory paragraph that wraps onto another line.' },
      { kind: 'heading', text: 'Improvements' },
      { kind: 'list', items: ['**A useful change.** With a wrapped explanation.', 'Another change.'] },
      { kind: 'paragraph', text: 'A separate closing note.' },
    ])
  })

  it.each([
    ['unreleased text', '# Changelog\n## Unreleased\n- A draft.'],
    ['invalid calendar date', '# Changelog\n## 2.0.0 — 2026-02-30\n- A change.'],
    ['missing release heading', '# Changelog\nA draft.'],
    ['empty release', '# Changelog\n## 2.0.0 — 2026-09-29\n### Fixes'],
    ['duplicate release', '# Changelog\n## 2.0.0 — 2026-09-29\n- A.\n## 2.0.0 — 2026-09-29\n- B.'],
  ])('rejects %s before bundling', (_name, source) => {
    expect(() => parseChangelog(source)).toThrow()
  })

  it('supports an empty neutral changelog for the shared base', () => {
    expect(parseChangelog('# Changelog\n')).toEqual([])
  })
})
