import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = realpathSync(process.cwd())
const categories = { added: 'Added', changed: 'Changed', fixed: 'Fixed', security: 'Security', removed: 'Removed' }
const bumps = ['none', 'patch', 'minor', 'major']
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const configPath = 'release.config.json'
const historyPath = 'releases/history.json'
const draftPath = 'releases/draft.json'
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const hash = (value) => createHash('sha256').update(value).digest('hex')
const fail = (message) => { throw new Error(message) }

// Every file operation is rooted in this checkout. Refuse symlinked metadata
// and inputs instead of following a path into another checkout or user data.
function filePath(name) {
  const path = resolve(root, name)
  if (!path.startsWith(`${root}/`)) fail('Path must stay inside the project')
  let current = root
  for (const part of name.split('/')) {
    if (!part || part === '.' || part === '..') fail('Invalid project path')
    current = join(current, part)
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`Symlinked input is not allowed: ${name}`)
  }
  return path
}

function read(name) { return readFileSync(filePath(name), 'utf8') }
function document(name) { return JSON.parse(read(name)) }
function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd() }
function gitRoot() {
  if (realpathSync(git('rev-parse', '--show-toplevel')) !== root) fail('Run this command from the root of its own Git checkout')
}
function refFile(ref, name) { return git('show', `${ref}:${name}`) }
function optionalRefFile(ref, name) {
  const paths = git('ls-tree', '--name-only', ref, '--', name).split('\n')
  return paths.includes(name) ? refFile(ref, name) : null
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) fail(`Invalid ${label} fields`)
}
function version(value) {
  if (typeof value !== 'string' || !versionPattern.test(value) || value.split('.').some((part) => !Number.isSafeInteger(Number(part)))) fail(`Invalid release version: ${value}`)
  return value.split('.').map(Number)
}
function compare(a, b) {
  const left = version(a), right = version(b)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  return 0
}
function date(value) {
  const stamp = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) fail('Date must be a real calendar date in YYYY-MM-DD format')
}

function config(value, pkg) {
  exactKeys(value, ['schemaVersion', 'brand', 'releaseBranch', 'tagPrefix', 'packageName', 'productName', 'aliases'], 'release configuration')
  if (value.schemaVersion !== 1 || !Array.isArray(value.aliases) || value.aliases.some((name) => typeof name !== 'string' || name.length < 2)) fail('Invalid release configuration')
  if (value.brand === null) {
    if ([value.releaseBranch, value.tagPrefix, value.packageName, value.productName].some((field) => field !== null) || value.aliases.length) fail('The shared base must have neutral release configuration')
  } else {
    if (!idPattern.test(value.brand) || typeof value.releaseBranch !== 'string' || !/^[a-z][a-z0-9/-]*$/.test(value.releaseBranch) || !/^[a-z][a-z0-9-]*-v$/.test(value.tagPrefix)) fail('Invalid current-brand identity')
    if (value.packageName !== pkg.name || !value.productName || typeof value.productName !== 'string') fail('Release configuration does not match this package')
    if (!value.aliases.length) fail('The current brand must declare its own names and symbols')
  }
  return value
}

function fragment(value, cfg, filename) {
  exactKeys(value, ['id', 'scope', 'type', 'bump', 'text'], 'change note')
  if (typeof value.id !== 'string' || !idPattern.test(value.id) || value.id.length > 80 || `${value.id}.json` !== filename) fail('Change note ID must match its neutral filename')
  const identityNames = [cfg.brand, cfg.productName, ...cfg.aliases].filter(Boolean).map((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
  if (identityNames.some((name) => name && `-${value.id}-`.includes(`-${name}-`)) || /(?:^|-)v?\d+-\d+-\d+(?:-|$)/.test(value.id) || /(?:^|-)[a-f0-9]{7,40}(?:-|$)/.test(value.id)) fail('Change note ID must be neutral and independent of brands, versions, and commit hashes')
  if (value.scope !== 'shared' && (cfg.brand === null || value.scope !== cfg.brand)) fail(`Change note ${value.id} belongs to another scope`)
  if (!Object.hasOwn(categories, value.type) && value.type !== 'internal') fail(`Invalid change category: ${value.id}`)
  if (!bumps.includes(value.bump) || (value.type === 'internal') !== (value.bump === 'none')) fail(`Invalid version impact: ${value.id}`)
  if (typeof value.text !== 'string' || !value.text.trim() || value.text !== value.text.trim() || /[\r\n]/.test(value.text)) fail(`Change note ${value.id} needs one nonempty paragraph`)
  if (value.scope === 'shared') {
    for (const alias of cfg.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(value.text)) fail(`Shared note ${value.id} contains the current brand's name or symbol`)
    }
  }
  return value
}

function renderNotes(notes) {
  return Object.entries(categories).flatMap(([type, title]) => {
    const matching = notes.filter((note) => note.type === type)
    return matching.length ? [`### ${title}\n\n${matching.map((note) => `- ${note.text}`).join('\n')}`] : []
  }).join('\n\n')
}
function changelog(state) {
  const records = state.draft ? [state.draft, ...state.history.releases] : state.history.releases
  return `# Changelog\n${records.map((entry) => `\n## ${entry.version} — ${entry.date}\n\n${entry.body}\n`).join('')}`
}

function checkRecord(record, state, used, isDraft = false) {
  exactKeys(record, ['version', 'date', 'tag', 'origin', 'changes', 'body', ...(isDraft ? ['sourceDigest'] : [])], 'release record')
  version(record.version)
  date(record.date)
  if (record.tag !== `${state.cfg.tagPrefix}${record.version}`) fail('Release record tag belongs to another brand or version')
  if (!Array.isArray(record.changes) || typeof record.body !== 'string' || !record.body.trim() || /^#{1,2}(?:\s|$)/m.test(record.body)) fail('Invalid release record content')
  if (!['imported', 'notes'].includes(record.origin) || (isDraft && record.origin !== 'notes')) fail('Invalid release record origin')
  for (const change of record.changes) {
    exactKeys(change, ['id', 'hash'], 'recorded change')
    const note = state.notes.find((note) => note.id === change.id)
    if (!idPattern.test(change.id) || !/^[a-f0-9]{64}$/.test(change.hash)) fail('Invalid recorded change identity')
    if (!isDraft && (!note || change.hash !== hash(json(note)))) fail(`Released note is missing or was changed: ${change.id}`)
    if (used.has(change.id)) fail(`Change note is included more than once: ${change.id}`)
    used.add(change.id)
  }
  if (!isDraft && record.origin === 'notes' && record.body !== renderNotes(record.changes.map(({ id }) => state.notes.find((note) => note.id === id)))) fail('Recorded release text differs from its included notes')
  if (isDraft && !/^[a-f0-9]{64}$/.test(record.sourceDigest)) fail('Invalid draft source digest')
}

function load() {
  const pkg = document('package.json')
  version(pkg.version)
  const cfg = config(document(configPath), pkg)
  const notes = readdirSync(filePath('changes')).filter((name) => name.endsWith('.json')).sort().map((name) => fragment(document(`changes/${name}`), cfg, name))
  const history = document(historyPath), draft = document(draftPath)
  exactKeys(history, ['schemaVersion', 'releases'], 'release history')
  if (history.schemaVersion !== 1 || !Array.isArray(history.releases)) fail('Invalid release history')
  const state = { pkg, cfg, notes, history, draft }
  if (cfg.brand === null && (history.releases.length || draft !== null)) fail('The shared base cannot contain brand release records')
  const used = new Set()
  for (let i = history.releases.length - 1; i >= 0; i--) {
    checkRecord(history.releases[i], state, used)
    if (i > 0 && compare(history.releases[i - 1].version, history.releases[i].version) <= 0) fail('Release history must have unique versions, newest first')
  }
  state.pending = notes.filter((note) => !used.has(note.id))
  if (draft !== null) {
    checkRecord(draft, state, used, true)
    if (history.releases.length && compare(draft.version, history.releases[0].version) <= 0) fail('Draft version must follow the last published release')
  }
  if (cfg.brand !== null && (draft ?? history.releases[0])?.version !== pkg.version) fail('Package version must match the draft or latest published release')
  return state
}

function assertChangelog(state) {
  if (read('CHANGELOG.md') !== changelog(state)) fail('CHANGELOG.md differs from the recorded release notes')
}

// Stable across rebases: hash source bytes and paths, never commit IDs. Exclude
// derived release state and local tool instructions; package.version is the
// only normalized source value.
function sourceDigest(ref) {
  gitRoot()
  const names = (ref ? git('ls-tree', '-r', '--name-only', '-z', ref) : git('ls-files', '--cached', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean)
  const inputs = [...new Set(names)].filter((name) => /^(src\/|build\/|resources\/|changes\/|\.github\/|package\.json$|pnpm-lock\.yaml$|release\.config\.json$|[^/]+\.(?:ts|mjs|yml|yaml|json)$)/.test(name)).sort()
  const digest = createHash('sha256')
  for (const name of inputs) {
    if (!ref && !existsSync(filePath(name))) continue
    let bytes = ref ? Buffer.from(execFileSync('git', ['show', `${ref}:${name}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })) : readFileSync(filePath(name))
    if (name === 'package.json') {
      const pkg = JSON.parse(bytes.toString('utf8'))
      delete pkg.version
      bytes = Buffer.from(json(pkg))
    }
    digest.update(name).update('\0').update(bytes).update('\0')
  }
  return digest.digest('hex')
}

function releaseBranch(state, tag) {
  if (state.cfg.brand === null) fail('Releases are disabled in the shared base')
  gitRoot()
  let branch = ''
  try { branch = git('symbolic-ref', '--short', 'HEAD') } catch { /* Tag checkouts are detached. */ }
  if (branch === state.cfg.releaseBranch) return
  if (!branch && tag && git('rev-parse', 'HEAD') === git('rev-parse', `${ownTag(state, tag)}^{commit}`)) return
  fail('Release preparation must run on the configured current-brand branch')
}
function ownTag(state, tag) {
  if (typeof tag !== 'string' || !tag.startsWith(state.cfg.tagPrefix)) fail('Tag must use the current brand prefix')
  version(tag.slice(state.cfg.tagPrefix.length))
  return `refs/tags/${tag}`
}

function assertDraft(state) {
  const expected = state.pending.map((note) => ({ id: note.id, hash: hash(json(note)) }))
  if (!state.draft || JSON.stringify(state.draft.changes) !== JSON.stringify(expected) || state.draft.body !== renderNotes(state.pending)) fail('Draft is stale; prepare it again with all pending notes')
  if (state.draft.sourceDigest !== sourceDigest()) fail('Source changed after release preparation; review and prepare the draft again')
}

function writeFiles(files) {
  const originals = new Map(), staged = []
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = filePath(name), temp = filePath(`${name}.pending-${process.pid}`)
      originals.set(path, existsSync(path) ? readFileSync(path) : null)
      writeFileSync(temp, text, { flag: 'wx' })
      staged.push({ path, temp })
    }
    for (const { path, temp } of staged) renameSync(temp, path)
  } catch (error) {
    for (const [path, bytes] of originals) {
      if (bytes === null) rmSync(path, { force: true })
      else writeFileSync(path, bytes)
    }
    throw error
  } finally {
    for (const { temp } of staged) rmSync(temp, { force: true })
  }
}

function preview(state) {
  const bump = state.pending.reduce((largest, note) => Math.max(largest, bumps.indexOf(note.bump)), 0)
  const base = state.history.releases[0]?.version ?? state.pkg.version
  const next = version(base)
  if (bump) { const index = 3 - bump; next[index]++; for (let i = index + 1; i < 3; i++) next[i] = 0 }
  return {
    brand: state.cfg.brand, packageVersion: state.pkg.version,
    published: state.history.releases.map(({ version, date, tag }) => ({ version, date, tag })),
    draft: state.draft ? { version: state.draft.version, date: state.draft.date, tag: state.draft.tag } : null,
    pending: state.pending, suggestedVersion: state.cfg.brand && bump ? next.join('.') : null,
  }
}

function prepare(state, values) {
  releaseBranch(state)
  version(values.version)
  date(values.date)
  if (state.history.releases.length && compare(values.version, state.history.releases[0].version) <= 0) fail('Choose a version newer than the last published release')
  const body = renderNotes(state.pending)
  if (!body) fail('There are no pending user-facing changes to release')
  const tag = `${state.cfg.tagPrefix}${values.version}`
  const ref = ownTag(state, tag)
  try { git('show-ref', '--verify', '--quiet', ref); fail('This version already has a tag; choose a new version') } catch (error) { if (!error.status) throw error }
  const draft = { version: values.version, date: values.date, tag, origin: 'notes', changes: state.pending.map((note) => ({ id: note.id, hash: hash(json(note)) })), body, sourceDigest: sourceDigest() }
  const pkg = { ...state.pkg, version: values.version }
  writeFiles({ 'package.json': json(pkg), [draftPath]: json(draft), 'CHANGELOG.md': changelog({ ...state, draft }) })
  return { prepared: tag, changes: draft.changes.map(({ id }) => id), published: false }
}

function record(state, values) {
  releaseBranch(state, values.tag)
  const ref = ownTag(state, values.tag)
  if (!state.draft || state.draft.tag !== values.tag) fail('The supplied tag must match the current draft')
  assertChangelog(state)
  assertDraft(state)
  const taggedConfig = JSON.parse(refFile(ref, configPath))
  if (json(taggedConfig) !== json(state.cfg) || json(JSON.parse(refFile(ref, 'package.json'))) !== json(state.pkg)) fail('Tag package or brand configuration does not match the prepared release')
  if (json(JSON.parse(refFile(ref, historyPath))) !== json(state.history)) fail('Tag release history does not match the prepared release')
  if (json(JSON.parse(refFile(ref, draftPath))) !== json(state.draft) || `${refFile(ref, 'CHANGELOG.md')}\n` !== changelog(state) || sourceDigest(ref) !== state.draft.sourceDigest) fail('Tag does not contain the reviewed release draft and source')
  const { sourceDigest: _digest, ...published } = state.draft
  const history = { schemaVersion: 1, releases: [published, ...state.history.releases] }
  writeFiles({ [historyPath]: json(history), [draftPath]: 'null\n', 'CHANGELOG.md': changelog({ ...state, history, draft: null }) })
  return { recordedPublication: values.tag }
}

function checkBase(state, base) {
  if (!/^[a-f0-9]{40}$/.test(base)) fail('--base requires an explicit full commit SHA')
  gitRoot()
  const previousConfig = optionalRefFile(base, configPath)
  if (previousConfig !== null && json(JSON.parse(previousConfig)) !== json(state.cfg)) fail('Release identity must match the selected base; do not compare different brand histories')
  const previousHistory = previousConfig === null ? { releases: [] } : JSON.parse(refFile(base, historyPath))
  for (const record of previousHistory.releases) {
    if (json(state.history.releases.find((entry) => entry.version === record.version)) !== json(record)) fail('Published release history cannot be rewritten')
  }
  if (previousConfig !== null && state.history.releases.some((record) => record.origin === 'imported' && !previousHistory.releases.some((previous) => previous.version === record.version))) fail('Historical imports are allowed only when bootstrapping release tracking')
  const files = git('diff', '--name-only', base, '--', '.').split('\n').filter(Boolean)
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)
  const changed = [...new Set([...files, ...untracked])].filter((name) => !/^(AGENTS\.md$|\.agents\/|\.codex\/)/.test(name))
  const needsNote = changed.some((name) => /^(src\/|build\/|resources\/|\.github\/|package\.json$|pnpm-lock\.yaml$)/.test(name))
  const consumed = new Set(previousHistory.releases.flatMap((entry) => entry.changes.map(({ id }) => id)))
  const hasTaskNote = changed.some((name) => {
    if (!/^changes\/[a-z0-9-]+\.json$/.test(name) || !existsSync(filePath(name))) return false
    const note = document(name), previous = optionalRefFile(base, name)
    return !consumed.has(note.id) && (previous === null || json(JSON.parse(previous)) !== json(note))
  })
  // Version-only changes and archiving an already reviewed draft need no new note.
  const substantive = changed.filter((name) => !['package.json', historyPath, draftPath, 'CHANGELOG.md'].includes(name))
  const previousPackage = JSON.parse(refFile(base, 'package.json')), currentPackage = { ...state.pkg }
  delete previousPackage.version; delete currentPackage.version
  if (needsNote && (substantive.length || json(previousPackage) !== json(currentPackage)) && !hasTaskNote) fail('Add or update an unreleased change note for this task, or an internal note explaining why it has no user-facing impact')
  return { comparedBase: base, ...(previousConfig === null ? { bootstrap: true } : {}) }
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  id: { type: 'string' }, scope: { type: 'string' }, type: { type: 'string' }, bump: { type: 'string' }, text: { type: 'string' },
  version: { type: 'string' }, date: { type: 'string' }, tag: { type: 'string' }, base: { type: 'string' }, strict: { type: 'boolean', default: false },
} })
const command = positionals[0]
let locked = false
try {
  if (positionals.length !== 1 || !['add', 'preview', 'prepare', 'check', 'record'].includes(command)) fail('Usage: node build/release.mjs add|preview|prepare|check|record [options]')
  if (['add', 'prepare', 'record'].includes(command)) {
    mkdirSync(filePath('releases/.lock'))
    locked = true
  }
  const state = load()
  let result
  if (command === 'add') {
    const note = fragment({ id: values.id, scope: values.scope ?? 'shared', type: values.type, bump: values.bump, text: values.text }, state.cfg, `${values.id}.json`)
    if (existsSync(filePath(`changes/${note.id}.json`))) fail('This change ID already exists; use a new stable ID')
    writeFiles({ [`changes/${note.id}.json`]: json(note) })
    result = { added: note.id }
  } else if (command === 'preview') result = preview(state)
  else if (command === 'prepare') result = prepare(state, values)
  else if (command === 'record') result = record(state, values)
  else {
    assertChangelog(state)
    if (values.strict) {
      releaseBranch(state, values.tag)
      if (!state.draft) fail('The release gate requires a prepared draft; published history alone cannot validate a new release')
      assertDraft(state)
      if (values.tag) {
        ownTag(state, values.tag)
        if (values.tag !== (state.draft ?? state.history.releases[0])?.tag) fail('Tag and release version disagree')
      }
    }
    result = { valid: true, ...(values.base ? checkBase(state, values.base) : {}) }
  }
  process.stdout.write(json(result))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
} finally {
  if (locked) rmSync(filePath('releases/.lock'), { recursive: true })
}
