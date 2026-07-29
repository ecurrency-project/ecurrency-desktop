import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLocalOrPrivateHost, NodeConfigStore, normalizeNodeUrl } from '../../src/main/vault/nodeConfig'

describe('normalizeNodeUrl', () => {
  it('accepts https and strips a trailing slash', () => {
    expect(normalizeNodeUrl('https://node.example:3002/')).toBe('https://node.example:3002')
  })

  it('accepts http for local / private / Tor hosts', () => {
    expect(normalizeNodeUrl('http://127.0.0.1:9668')).toBe('http://127.0.0.1:9668')
    expect(normalizeNodeUrl('http://localhost:9668')).toBe('http://localhost:9668')
    expect(normalizeNodeUrl('http://192.168.1.50:9668')).toBe('http://192.168.1.50:9668')
    expect(normalizeNodeUrl('http://abcdefghij234567.onion')).toBe('http://abcdefghij234567.onion')
  })

  it('rejects plain http to a remote host (would leak traffic + credentials)', () => {
    expect(() => normalizeNodeUrl('http://node.example.com')).toThrow()
    expect(() => normalizeNodeUrl('http://8.8.8.8:9668')).toThrow()
  })

  it('still accepts https to a remote host', () => {
    expect(normalizeNodeUrl('https://node.example.com:3002/')).toBe('https://node.example.com:3002')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeNodeUrl('  https://node.example  ')).toBe('https://node.example')
  })

  it('rejects empty, non-URL, and non-http(s) input', () => {
    expect(() => normalizeNodeUrl('   ')).toThrow()
    expect(() => normalizeNodeUrl('not a url')).toThrow()
    expect(() => normalizeNodeUrl('ftp://node.example')).toThrow()
  })

  it('rejects credentials embedded in the URL (they would land in the PLAIN node.json)', () => {
    expect(() => normalizeNodeUrl('https://user:secret@node.example')).toThrow(/credentials/i)
    expect(() => normalizeNodeUrl('https://user@node.example')).toThrow(/credentials/i)
    // …even for local hosts, where http is otherwise fine.
    expect(() => normalizeNodeUrl('http://user:secret@127.0.0.1:9668')).toThrow(/credentials/i)
  })

  it('rejects a query string or fragment on the base URL', () => {
    expect(() => normalizeNodeUrl('https://node.example?token=x')).toThrow()
    expect(() => normalizeNodeUrl('https://node.example#frag')).toThrow()
  })
})

describe('isLocalOrPrivateHost', () => {
  it('treats loopback / private / link-local / onion as local', () => {
    for (const h of ['localhost', '127.0.0.1', '127.5.6.7', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '::1', 'fe80::1', 'fc00::1', 'dev.localhost', 'xyz.onion']) {
      expect(isLocalOrPrivateHost(h)).toBe(true)
    }
  })

  it('treats public hosts / addresses as remote', () => {
    for (const h of ['node.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '193.168.1.1', 'fcbank.com', 'fe.example.com', '2001:4860:4860::8888']) {
      expect(isLocalOrPrivateHost(h)).toBe(false)
    }
  })
})

describe('NodeConfigStore', () => {
  const freshFile = (): string => join(mkdtempSync(join(tmpdir(), 'wallet-node-')), 'node.json')

  it('defaults to the public slot with Tor off', () => {
    const s = new NodeConfigStore(freshFile()).getSettings()
    expect(s).toEqual({ selected: 'public', tor: false, customNodes: [] })
  })

  it('persists an own-node URL + selection across instances', () => {
    const file = freshFile()
    const store = new NodeConfigStore(file)
    store.setOwnUrl('http://127.0.0.1:9668')
    store.setSelected('own')
    expect(new NodeConfigStore(file).getSettings()).toEqual({ selected: 'own', ownUrl: 'http://127.0.0.1:9668', tor: false, customNodes: [] })
  })

  it('clearing the own URL falls back to the public slot', () => {
    const file = freshFile()
    const store = new NodeConfigStore(file)
    store.setOwnUrl('http://127.0.0.1:9668')
    store.setSelected('own')
    store.clearOwnUrl()
    const s = new NodeConfigStore(file).getSettings()
    expect(s.selected).toBe('public')
    expect(s.ownUrl).toBeUndefined()
  })

  it('persists the Tor flag', () => {
    const file = freshFile()
    const store = new NodeConfigStore(file)
    store.setTor(true)
    expect(new NodeConfigStore(file).getSettings().tor).toBe(true)
  })

  it('ignores a stored own selection without a URL', () => {
    const file = freshFile()
    // setSelected('own') with no URL set: read() guards it back to public.
    new NodeConfigStore(file).setSelected('own')
    expect(new NodeConfigStore(file).getSettings().selected).toBe('public')
  })
})

describe('NodeConfigStore — custom public nodes', () => {
  const file = (): string => join(mkdtempSync(join(tmpdir(), 'nodecfg-')), 'node.json')

  it('adds, persists and renames custom nodes (deduped by URL)', () => {
    const path = file()
    const store = new NodeConfigStore(path)
    store.addCustomNode('https://a.example', 'Alpha')
    store.addCustomNode('https://b.example')
    store.addCustomNode('https://a.example', 'Alpha Two') // rename, not duplicate
    const again = new NodeConfigStore(path)
    expect(again.getSettings().customNodes).toEqual([
      { url: 'https://b.example' },
      { url: 'https://a.example', name: 'Alpha Two' },
    ])
  })

  it('selects a custom node and survives a reload', () => {
    const path = file()
    const store = new NodeConfigStore(path)
    store.addCustomNode('https://a.example')
    store.setSelected('custom', 'https://a.example')
    const again = new NodeConfigStore(path)
    expect(again.getSettings().selected).toBe('custom')
    expect(again.getSettings().selectedCustomUrl).toBe('https://a.example')
  })

  it('refuses to select a custom node that is not in the list', () => {
    const store = new NodeConfigStore(file())
    expect(() => store.setSelected('custom', 'https://ghost.example')).toThrow(/not in the list/)
  })

  it('removing the ACTIVE custom node falls back to the public slot', () => {
    const path = file()
    const store = new NodeConfigStore(path)
    store.addCustomNode('https://a.example')
    store.setSelected('custom', 'https://a.example')
    store.removeCustomNode('https://a.example')
    const s = new NodeConfigStore(path).getSettings()
    expect(s.selected).toBe('public')
    expect(s.selectedCustomUrl).toBeUndefined()
    expect(s.customNodes).toEqual([])
  })

  it('removing an INACTIVE custom node keeps the selection', () => {
    const path = file()
    const store = new NodeConfigStore(path)
    store.addCustomNode('https://a.example')
    store.addCustomNode('https://b.example')
    store.setSelected('custom', 'https://a.example')
    store.removeCustomNode('https://b.example')
    const s = new NodeConfigStore(path).getSettings()
    expect(s.selected).toBe('custom')
    expect(s.selectedCustomUrl).toBe('https://a.example')
  })

  it('clearing the own URL leaves custom nodes untouched', () => {
    const path = file()
    const store = new NodeConfigStore(path)
    store.addCustomNode('https://a.example', 'Alpha')
    store.setOwnUrl('http://127.0.0.1:9668')
    store.setSelected('own')
    store.clearOwnUrl()
    const s = new NodeConfigStore(path).getSettings()
    expect(s.selected).toBe('public')
    expect(s.customNodes).toEqual([{ url: 'https://a.example', name: 'Alpha' }])
  })

  it('drops malformed custom entries on read instead of failing', () => {
    const path = file()
    const store = new NodeConfigStore(path)
    store.addCustomNode('https://a.example')
    // Corrupt the stored list by hand: only the valid entry must survive.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { customNodes: unknown[] }
    raw.customNodes = [...raw.customNodes, null, 42, { name: 'no-url' }, { url: '' }]
    writeFileSync(path, JSON.stringify(raw))
    expect(new NodeConfigStore(path).getSettings().customNodes).toEqual([{ url: 'https://a.example' }])
  })

  it('a stored custom selection pointing at a missing node falls back to public', () => {
    const path = file()
    const store = new NodeConfigStore(path)
    store.addCustomNode('https://a.example')
    store.setSelected('custom', 'https://a.example')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { customNodes: unknown[] }
    raw.customNodes = []
    writeFileSync(path, JSON.stringify(raw))
    expect(new NodeConfigStore(path).getSettings().selected).toBe('public')
  })
})
