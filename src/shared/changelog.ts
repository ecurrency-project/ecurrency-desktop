export type ChangelogBlock =
  | { kind: 'heading' | 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }

export interface ReleaseNotes {
  version: string
  date: string
  blocks: ChangelogBlock[]
}

// The bundled changelog uses a small Markdown subset: release/section headings,
// paragraphs, bullet lists and inline **bold**. Content stays text, never HTML.
// Parse at build time so a malformed release cannot silently ship without notes.
export function parseChangelog(markdown: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = []
  let release: ReleaseNotes | undefined
  let separated = true
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) { separated = true; continue }
    if (line === '# Changelog' && releases.length === 0) continue
    if (line.startsWith('## ')) {
      const match = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/.exec(line)
      if (!match) throw new Error(`Invalid changelog release heading: ${line}`)
      const [, version, date] = match
      const timestamp = Date.parse(`${date}T00:00:00Z`)
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new Error(`Invalid release date: ${date}`)
      if (releases.some((entry) => entry.version === version)) throw new Error(`Duplicate changelog version: ${version}`)
      release = { version, date, blocks: [] }
      releases.push(release)
      separated = true
      continue
    }
    if (!release) throw new Error('Changelog content must follow a release heading')
    const previous = release.blocks.at(-1)
    if (line.startsWith('### ')) {
      release.blocks.push({ kind: 'heading', text: line.slice(4) })
    } else if (line.startsWith('- ')) {
      if (previous?.kind === 'list') previous.items.push(line.slice(2))
      else release.blocks.push({ kind: 'list', items: [line.slice(2)] })
    } else if (line.startsWith('#')) {
      throw new Error(`Unsupported changelog heading: ${line}`)
    } else if (!separated && previous?.kind === 'list') {
      previous.items[previous.items.length - 1] += ` ${line}`
    } else if (!separated && previous?.kind === 'paragraph') {
      previous.text += ` ${line}`
    } else {
      release.blocks.push({ kind: 'paragraph', text: line })
    }
    separated = false
  }
  for (const entry of releases) {
    if (!entry.blocks.some((block) => block.kind !== 'heading')) throw new Error(`Empty release notes: ${entry.version}`)
  }
  return releases
}
