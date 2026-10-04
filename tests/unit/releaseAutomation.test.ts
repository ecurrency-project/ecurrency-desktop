import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseChangelog } from '../../src/shared/changelog'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const scriptPath = join(projectRoot, 'build/release.mjs')
const fixtureParent = join(projectRoot, 'test-results')
const commandEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '' }
const releaseDate = '2031-04-05'
const note = {
  id: 'history-rewards', scope: 'shared', type: 'fixed', bump: 'patch',
  text: 'Staking rewards now appear in transaction history.',
}

interface Fixture {
  root: string
  brand: string
  tagPrefix: string
  nextVersion: string
}
interface ReleaseRecord {
  version: string
  date: string
  tag: string
  origin: 'imported' | 'notes'
  changes: { id: string; hash: string }[]
  body: string
  sourceDigest?: string
}
interface Preview {
  brand: string | null
  packageVersion: string
  draft: { version: string } | null
  published: { version: string }[]
  pending: (typeof note)[]
  suggestedVersion: string | null
}

let testRoot: string

function write(root: string, name: string, text: string) {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
function writeJson(root: string, name: string, value: unknown) {
  write(root, name, `${JSON.stringify(value, null, 2)}\n`)
}
function read(root: string, name: string) { return readFileSync(join(root, name), 'utf8') }
function readJson<T>(root: string, name: string): T { return JSON.parse(read(root, name)) }

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: commandEnv })
  expect(result.status, result.stderr || result.error?.message).toBe(0)
  return result.stdout.trimEnd()
}
function commit(fixture: Fixture, message = 'Save fixture changes') {
  git(fixture.root, 'add', '--all')
  git(fixture.root, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message)
  return git(fixture.root, 'rev-parse', 'HEAD')
}
function cli(fixture: Fixture, ...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: fixture.root, encoding: 'utf8', env: commandEnv,
  })
}
function succeeds<T = Record<string, unknown>>(fixture: Fixture, ...args: string[]): T {
  const result = cli(fixture, ...args)
  expect(result.status, result.stderr || result.error?.message).toBe(0)
  return JSON.parse(result.stdout)
}
function fails(fixture: Fixture, args: string[], message?: RegExp) {
  const result = cli(fixture, ...args)
  expect(result.status, result.stdout).not.toBe(0)
  expect(result.stderr).not.toBe('')
  if (message) expect(result.stderr).toMatch(message)
}
function createFixture(brand = 'north'): Fixture {
  const root = join(testRoot, brand)
  mkdirSync(join(root, 'changes'), { recursive: true })
  const previousVersion = brand === 'north' ? '7.4.2' : '9.2.3'
  const fixture = {
    root, brand, tagPrefix: `${brand}-v`, nextVersion: brand === 'north' ? '7.5.0' : '9.3.0',
  }
  const displayName = brand[0].toUpperCase() + brand.slice(1)
  writeJson(root, 'package.json', { name: `${brand}-wallet`, version: previousVersion, private: true })
  writeJson(root, 'release.config.json', {
    schemaVersion: 1, brand, releaseBranch: brand, tagPrefix: fixture.tagPrefix,
    packageName: `${brand}-wallet`, productName: `${displayName} Wallet`, aliases: [displayName],
  })
  const previous = {
    version: previousVersion, date: '2031-03-01', tag: `${fixture.tagPrefix}${previousVersion}`,
    origin: 'imported', changes: [], body: '### Added\n\n- Initial public release.',
  }
  writeJson(root, 'releases/history.json', { schemaVersion: 1, releases: [previous] })
  writeJson(root, 'releases/draft.json', null)
  write(root, 'CHANGELOG.md', `# Changelog\n\n## ${previous.version} — ${previous.date}\n\n${previous.body}\n`)
  write(root, 'src/history.ts', 'export const historyEnabled = true\n')
  git(root, 'init', '--quiet', '--template=', `--initial-branch=${brand}`)
  git(root, 'config', '--local', 'user.name', 'Test')
  git(root, 'config', '--local', 'user.email', 'test@example.invalid')
  commit(fixture, 'Create fixture baseline')
  return fixture
}
function add(fixture: Fixture, value = note) {
  return succeeds(fixture, 'add', '--id', value.id, '--scope', value.scope, '--type', value.type,
    '--bump', value.bump, '--text', value.text)
}
function prepare(fixture: Fixture) {
  return succeeds(fixture, 'prepare', '--version', fixture.nextVersion, '--date', releaseDate)
}
function tagPrepared(fixture: Fixture) {
  commit(fixture, 'Prepare fixture release')
  const tag = `${fixture.tagPrefix}${fixture.nextVersion}`
  git(fixture.root, '-c', 'tag.gpgsign=false', 'tag', tag)
  return tag
}
function publish(fixture: Fixture) {
  prepare(fixture)
  const tag = tagPrepared(fixture)
  succeeds(fixture, 'record', '--tag', tag)
  return tag
}

beforeEach(() => {
  mkdirSync(fixtureParent, { recursive: true })
  testRoot = mkdtempSync(join(fixtureParent, 'release-automation-'))
})
afterEach(() => { rmSync(testRoot, { recursive: true, force: true }) })

describe('release automation CLI', () => {
  it('keeps pending development notes separate from published releases', () => {
    const fixture = createFixture()
    expect(add(fixture)).toEqual({ added: note.id })
    expect(readJson(fixture.root, `changes/${note.id}.json`)).toEqual(note)
    expect(succeeds<Preview>(fixture, 'preview')).toMatchObject({
      brand: 'north', packageVersion: '7.4.2', draft: null,
      pending: [note], published: [{ version: '7.4.2' }], suggestedVersion: '7.4.3',
    })
    succeeds(fixture, 'check')
    fails(fixture, ['check', '--strict'], /pending|prepared/i)
    fails(fixture, ['add', '--id', note.id, '--type', note.type, '--bump', note.bump,
      '--text', note.text], /already exists/i)
  })

  it('prepares idempotently without consuming notes or rewriting published history', () => {
    const fixture = createFixture()
    add(fixture)
    const history = read(fixture.root, 'releases/history.json')
    expect(prepare(fixture)).toMatchObject({ published: false, changes: [note.id] })
    const firstDraft = read(fixture.root, 'releases/draft.json')
    const firstChangelog = read(fixture.root, 'CHANGELOG.md')
    prepare(fixture)
    expect(read(fixture.root, 'releases/draft.json')).toBe(firstDraft)
    expect(read(fixture.root, 'CHANGELOG.md')).toBe(firstChangelog)
    expect(read(fixture.root, 'releases/history.json')).toBe(history)
    expect(succeeds<Preview>(fixture, 'preview').pending).toEqual([note])
    expect(readJson<{ version: string }>(fixture.root, 'package.json').version).toBe(fixture.nextVersion)
    succeeds(fixture, 'check', '--strict', '--tag', `${fixture.tagPrefix}${fixture.nextVersion}`)
  })

  it('generates Markdown that the application parser accepts and omits internal prose', () => {
    const fixture = createFixture()
    add(fixture)
    add(fixture, { ...note, id: 'release-validation', type: 'internal', bump: 'none', text: 'Validate release metadata.' })
    prepare(fixture)
    const markdown = read(fixture.root, 'CHANGELOG.md')
    expect(markdown).not.toContain('Validate release metadata.')
    expect(parseChangelog(markdown)).toEqual([
      { version: fixture.nextVersion, date: releaseDate, blocks: [
        { kind: 'heading', text: 'Fixed' }, { kind: 'list', items: [note.text] },
      ] },
      { version: '7.4.2', date: '2031-03-01', blocks: [
        { kind: 'heading', text: 'Added' }, { kind: 'list', items: ['Initial public release.'] },
      ] },
    ])
    expect(readJson<ReleaseRecord>(fixture.root, 'releases/draft.json').changes.map(({ id }) => id))
      .toEqual(['history-rewards', 'release-validation'])
  })

  it('does not recommend or prepare a user release from only internal notes', () => {
    const fixture = createFixture()
    add(fixture, { ...note, type: 'internal', bump: 'none', text: 'Validate release metadata.' })
    expect(succeeds<Preview>(fixture, 'preview').suggestedVersion).toBeNull()
    fails(fixture, ['prepare', '--version', fixture.nextVersion, '--date', releaseDate], /user-facing/i)
    expect(readJson(fixture.root, 'releases/draft.json')).toBeNull()
  })

  it('requires preparation again after source changes', () => {
    const fixture = createFixture()
    add(fixture)
    prepare(fixture)
    write(fixture.root, 'src/history.ts', 'export const historyEnabled = false\n')
    fails(fixture, ['check', '--strict'], /source changed|stale/i)
    prepare(fixture)
    succeeds(fixture, 'check', '--strict')
  })

  it('allows revising an unpublished note and regenerating its stale draft', () => {
    const fixture = createFixture()
    add(fixture)
    prepare(fixture)
    const revised = { ...note, text: 'Transaction history includes staking rewards.' }
    writeJson(fixture.root, `changes/${note.id}.json`, revised)
    fails(fixture, ['check', '--strict'], /changed|stale/i)
    prepare(fixture)
    succeeds(fixture, 'check', '--strict')
    expect(read(fixture.root, 'CHANGELOG.md')).toContain(revised.text)
  })

  it('requires a draft to include notes added after its preparation', () => {
    const fixture = createFixture()
    add(fixture)
    prepare(fixture)
    add(fixture, { ...note, id: 'read-release-history', type: 'added', bump: 'minor', text: 'Read release history inside the application.' })
    fails(fixture, ['check', '--strict'], /stale|changed/i)
    prepare(fixture)
    succeeds(fixture, 'check', '--strict')
  })

  it.each(['src/history.ts', `changes/${note.id}.json`])('can regenerate after deleting unpublished tracked input %s', (path) => {
    const fixture = createFixture()
    add(fixture)
    add(fixture, { ...note, id: 'read-release-history', type: 'added', bump: 'minor', text: 'Read release history inside the application.' })
    commit(fixture)
    prepare(fixture)
    rmSync(join(fixture.root, path))
    fails(fixture, ['check', '--strict'])
    prepare(fixture)
    succeeds(fixture, 'check', '--strict')
    if (path.startsWith('changes/')) {
      expect(readJson<ReleaseRecord>(fixture.root, 'releases/draft.json').changes.map(({ id }) => id))
        .toEqual(['read-release-history'])
    }
  })

  it('consumes the same shared stable ID independently for each profile', () => {
    const north = createFixture('north')
    const south = createFixture('south')
    add(north)
    add(south)
    publish(north)
    expect(succeeds<Preview>(north, 'preview').pending).toEqual([])
    expect(succeeds<Preview>(south, 'preview').pending).toEqual([note])
    expect(read(south.root, 'CHANGELOG.md')).not.toContain('north')
    publish(south)
    expect(succeeds<Preview>(south, 'preview').pending).toEqual([])
    expect(read(north.root, `changes/${note.id}.json`)).toBe(read(south.root, `changes/${note.id}.json`))
    expect(readJson<{ releases: ReleaseRecord[] }>(north.root, 'releases/history.json').releases[0].tag)
      .toBe(`north-v${north.nextVersion}`)
    expect(readJson<{ releases: ReleaseRecord[] }>(south.root, 'releases/history.json').releases[0].tag)
      .toBe(`south-v${south.nextVersion}`)
  })

  it('records publication only from the exact tagged draft and archives it once', () => {
    const fixture = createFixture()
    add(fixture)
    prepare(fixture)
    const changelog = read(fixture.root, 'CHANGELOG.md')
    const tag = tagPrepared(fixture)
    expect(succeeds(fixture, 'record', '--tag', tag)).toEqual({ recordedPublication: tag })
    expect(readJson(fixture.root, 'releases/draft.json')).toBeNull()
    expect(read(fixture.root, 'CHANGELOG.md')).toBe(changelog)
    const history = readJson<{ releases: ReleaseRecord[] }>(fixture.root, 'releases/history.json')
    expect(history.releases).toHaveLength(2)
    expect(history.releases[0]).toMatchObject({ version: fixture.nextVersion, origin: 'notes', tag })
    expect(history.releases[0]).not.toHaveProperty('sourceDigest')
    succeeds(fixture, 'check')
    fails(fixture, ['record', '--tag', tag], /draft/i)
  })

  it('does not approve a new release from published history after an unnoted source change', () => {
    const fixture = createFixture()
    add(fixture)
    const tag = publish(fixture)
    write(fixture.root, 'src/history.ts', 'export const historyEnabled = false\n')
    succeeds(fixture, 'check')
    fails(fixture, ['check', '--strict', '--tag', tag], /prepared draft/i)
  })

  it('rejects a foreign or nonexistent tag without consuming the draft', () => {
    const fixture = createFixture()
    add(fixture)
    prepare(fixture)
    const draft = read(fixture.root, 'releases/draft.json')
    fails(fixture, ['record', '--tag', `south-v${fixture.nextVersion}`], /prefix|brand/i)
    fails(fixture, ['record', '--tag', `${fixture.tagPrefix}${fixture.nextVersion}`])
    expect(read(fixture.root, 'releases/draft.json')).toBe(draft)
    expect(succeeds<Preview>(fixture, 'preview').published).toHaveLength(1)
  })

  it('rejects a tag whose source differs even if its draft and version match', () => {
    const fixture = createFixture()
    add(fixture)
    prepare(fixture)
    write(fixture.root, 'src/history.ts', 'export const historyEnabled = false\n')
    const tag = tagPrepared(fixture)
    write(fixture.root, 'src/history.ts', 'export const historyEnabled = true\n')
    fails(fixture, ['record', '--tag', tag], /source|reviewed/i)
    expect(readJson<ReleaseRecord>(fixture.root, 'releases/draft.json').tag).toBe(tag)
  })

  it.each(['edit', 'delete'])('rejects a published note %s', (operation) => {
    const fixture = createFixture()
    add(fixture)
    publish(fixture)
    if (operation === 'edit') writeJson(fixture.root, `changes/${note.id}.json`, { ...note, text: 'Revised published prose.' })
    else rmSync(join(fixture.root, `changes/${note.id}.json`))
    fails(fixture, ['check'], /released note.*missing|released note.*changed/i)
  })

  it('keeps a shared profile neutral and refuses release preparation', () => {
    const fixture = createFixture()
    writeJson(fixture.root, 'release.config.json', {
      schemaVersion: 1, brand: null, releaseBranch: null, tagPrefix: null,
      packageName: null, productName: null, aliases: [],
    })
    writeJson(fixture.root, 'releases/history.json', { schemaVersion: 1, releases: [] })
    write(fixture.root, 'CHANGELOG.md', '# Changelog\n')
    add(fixture)
    succeeds(fixture, 'check')
    expect(succeeds<Preview>(fixture, 'preview')).toMatchObject({ brand: null, suggestedVersion: null })
    fails(fixture, ['prepare', '--version', fixture.nextVersion, '--date', releaseDate], /disabled|shared base/i)
  })

  it('rejects foreign note scopes when adding and when reading existing files', () => {
    const fixture = createFixture()
    fails(fixture, ['add', '--id', note.id, '--scope', 'south', '--type', note.type,
      '--bump', note.bump, '--text', note.text], /another scope/i)
    writeJson(fixture.root, `changes/${note.id}.json`, { ...note, scope: 'south' })
    fails(fixture, ['check'], /another scope/i)
  })

  it('rejects current-brand prose in shared notes while allowing its own scope', () => {
    const fixture = createFixture()
    const branded = { ...note, text: 'North Wallet now shows staking rewards.' }
    fails(fixture, ['add', '--id', note.id, '--type', note.type, '--bump', note.bump,
      '--text', branded.text], /brand.*name|symbol/i)
    add(fixture, { ...branded, scope: 'north' })
    succeeds(fixture, 'check')
  })

  it.each(['north-history', 'release-v7-4-2', `fix-${'a'.repeat(40)}`])('rejects non-neutral stable ID %s', (id) => {
    const fixture = createFixture()
    fails(fixture, ['add', '--id', id, '--type', note.type, '--bump', note.bump,
      '--text', note.text], /neutral|brands.*versions.*hashes/i)
    expect(succeeds<Preview>(fixture, 'preview').pending).toEqual([])
  })

  it('rejects package/config identity mismatches and release preparation on the wrong branch', () => {
    const fixture = createFixture()
    add(fixture)
    const pkg = readJson<Record<string, unknown>>(fixture.root, 'package.json')
    writeJson(fixture.root, 'package.json', { ...pkg, name: 'south-wallet' })
    fails(fixture, ['check'], /configuration.*package/i)
    writeJson(fixture.root, 'package.json', pkg)
    git(fixture.root, 'checkout', '--quiet', '-b', 'work')
    fails(fixture, ['prepare', '--version', fixture.nextVersion, '--date', releaseDate], /branch/i)
  })

  it('refuses a symlinked note even when its target is a valid note in another fixture', () => {
    const fixture = createFixture()
    const target = join(testRoot, 'outside-note.json')
    writeFileSync(target, JSON.stringify(note))
    symlinkSync(target, join(fixture.root, `changes/${note.id}.json`))
    fails(fixture, ['preview'], /symlink/i)
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(note))
  })

  it('requires a new task note for source changes relative to an explicit base', () => {
    const fixture = createFixture()
    const base = git(fixture.root, 'rev-parse', 'HEAD')
    write(fixture.root, 'src/history.ts', 'export const historyEnabled = false\n')
    fails(fixture, ['check', '--base', base], /add.*change note/i)
    add(fixture)
    expect(succeeds(fixture, 'check', '--base', base)).toMatchObject({ valid: true, comparedBase: base })
    fails(fixture, ['check', '--base', base.slice(0, 7)], /full commit SHA/i)
  })

  it('requires a task note for bundled resource changes', () => {
    const fixture = createFixture()
    write(fixture.root, 'resources/banner.txt', 'Application banner.\n')
    const base = commit(fixture)
    write(fixture.root, 'resources/banner.txt', 'Updated application banner.\n')
    fails(fixture, ['check', '--base', base], /add.*change note/i)
    add(fixture, { ...note, id: 'application-banner', type: 'changed', text: 'Update the application banner.' })
    succeeds(fixture, 'check', '--base', base)
  })

  it('checks change-note coverage when bootstrapping metadata onto a legacy checkout', () => {
    const fixture = createFixture()
    const files = ['release.config.json', 'releases/history.json', 'releases/draft.json', 'CHANGELOG.md']
    const initialMetadata = new Map(files.map((name) => [name, read(fixture.root, name)]))
    for (const name of files) rmSync(join(fixture.root, name))
    const base = commit(fixture, 'Create legacy fixture baseline')
    for (const [name, text] of initialMetadata) write(fixture.root, name, text)
    write(fixture.root, 'src/history.ts', 'export const historyEnabled = false\n')
    fails(fixture, ['check', '--base', base], /add.*change note/i)
    add(fixture)
    expect(succeeds(fixture, 'check', '--base', base)).toMatchObject({
      valid: true, comparedBase: base, bootstrap: true,
    })
  })

  it('requires new or revised unreleased prose to cover a later source change', () => {
    const fixture = createFixture()
    add(fixture)
    const base = commit(fixture)
    write(fixture.root, 'src/history.ts', 'export const historyEnabled = false\n')
    fails(fixture, ['check', '--base', base], /add.*change note/i)
    writeJson(fixture.root, `changes/${note.id}.json`, { ...note, text: 'Transaction history is refreshed.' })
    succeeds(fixture, 'check', '--base', base)
  })

  it('rejects a different profile identity relative to the selected base', () => {
    const fixture = createFixture()
    const base = git(fixture.root, 'rev-parse', 'HEAD')
    const config = readJson<Record<string, unknown>>(fixture.root, 'release.config.json')
    writeJson(fixture.root, 'release.config.json', { ...config, productName: 'North Desktop' })
    fails(fixture, ['check', '--base', base], /identity.*base|brand histories/i)
  })

  it('rejects rewriting published history even when the changelog is changed to match', () => {
    const fixture = createFixture()
    const base = git(fixture.root, 'rev-parse', 'HEAD')
    const history = readJson<{ releases: ReleaseRecord[] }>(fixture.root, 'releases/history.json')
    history.releases[0].body = '### Added\n\n- Replacement public history.'
    writeJson(fixture.root, 'releases/history.json', history)
    const previous = history.releases[0]
    write(fixture.root, 'CHANGELOG.md', `# Changelog\n\n## ${previous.version} — ${previous.date}\n\n${previous.body}\n`)
    fails(fixture, ['check', '--base', base], /published release history cannot be rewritten/i)
  })

  it.each([
    ['--date', '2031-02-29'],
    ['--version', '7.4.2'],
  ])('rejects an invalid preparation %s %s without changing release files', (flag, value) => {
    const fixture = createFixture()
    add(fixture)
    const packageBefore = read(fixture.root, 'package.json')
    const args = ['prepare', '--version', fixture.nextVersion, '--date', releaseDate]
    args[args.indexOf(flag) + 1] = value
    fails(fixture, args, /date|newer/i)
    expect(readJson(fixture.root, 'releases/draft.json')).toBeNull()
    expect(read(fixture.root, 'package.json')).toBe(packageBefore)
  })
})
