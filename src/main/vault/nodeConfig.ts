import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Node-selection configuration for the Network card.
//
// A small PLAIN JSON file (like the wallet registry): which backend slot is active
// ('public' or 'own'), the user's own-node URL if set, and the Tor flag. It holds no
// key material and must be readable at startup so the chain client can be built
// before any unlock. Electrum is not persisted yet (its slot is not wired).

export type StoredNodeKind = 'public' | 'own'

export interface NodeSettingsStored {
  readonly selected: StoredNodeKind
  readonly ownUrl?: string
  readonly tor: boolean
}

interface NodeConfigFile {
  readonly version: number
  readonly selected: StoredNodeKind
  readonly ownUrl?: string
  readonly tor: boolean
}

const NODE_CONFIG_VERSION = 1

export class NodeConfigStore {
  private data: NodeConfigFile

  constructor(private readonly file: string) {
    this.data = this.read()
  }

  getSettings(): NodeSettingsStored {
    const s: { selected: StoredNodeKind; ownUrl?: string; tor: boolean } = { selected: this.data.selected, tor: this.data.tor }
    if (this.data.ownUrl !== undefined) s.ownUrl = this.data.ownUrl
    return s
  }

  setSelected(kind: StoredNodeKind): void {
    this.persist({ ...this.data, selected: kind })
  }

  setOwnUrl(url: string): void {
    this.persist({ ...this.data, ownUrl: url })
  }

  // Drop the own-node URL; if it was the active slot, fall back to the public node.
  clearOwnUrl(): void {
    this.persist({ version: NODE_CONFIG_VERSION, selected: this.data.selected === 'own' ? 'public' : this.data.selected, tor: this.data.tor })
  }

  setTor(enabled: boolean): void {
    this.persist({ ...this.data, tor: enabled })
  }

  private persist(next: NodeConfigFile): void {
    this.data = next
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private read(): NodeConfigFile {
    try {
      const p = JSON.parse(readFileSync(this.file, 'utf8')) as { selected?: unknown; ownUrl?: unknown; tor?: unknown }
      const ownUrl = typeof p.ownUrl === 'string' && p.ownUrl.length > 0 ? p.ownUrl : undefined
      // 'own' only makes sense with a URL; otherwise fall back to the public node.
      const selected: StoredNodeKind = p.selected === 'own' && ownUrl !== undefined ? 'own' : 'public'
      const base: NodeConfigFile = { version: NODE_CONFIG_VERSION, selected, tor: p.tor === true }
      return ownUrl !== undefined ? { ...base, ownUrl } : base
    } catch {
      return { version: NODE_CONFIG_VERSION, selected: 'public', tor: false }
    }
  }
}

// Hosts for which plaintext http:// is acceptable: loopback, RFC1918 / link-local
// private ranges, and Tor .onion (which is end-to-end encrypted at the transport).
// Any other host is public/remote, where http would expose the request — and any
// Basic-auth node credentials — to network observers, so those must use https.
export function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  if (h.endsWith('.localhost') || h.endsWith('.onion')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4 !== null) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a > 255 || b > 255 || Number(v4[3]) > 255 || Number(v4[4]) > 255) return false
    if (a === 127 || a === 10) return true // loopback 127.0.0.0/8, private 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 169 && b === 254) return true // link-local 169.254.0.0/16
    return false
  }
  // IPv6 literals only (they contain ':'); ::1 is handled above.
  if (h.includes(':')) {
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true // fe80::/10
    if (h.startsWith('fc') || h.startsWith('fd')) return true // unique-local fc00::/7
  }
  return false
}

// Validate + normalize a user-entered node URL: an http(s) base URL with no trailing
// slash (NodeEndpoint.url is expected without one). Plain http:// is allowed only for
// local/private/Tor hosts (see isLocalOrPrivateHost); a remote host must use https://
// so traffic and any node credentials aren't sent in the clear. Credentials embedded
// in the URL are refused outright: this string is persisted in the PLAIN node.json,
// while auth belongs in the sealed NodeAuthStore — accepting `user:pass@host` would
// silently write the password to disk in the clear. Query strings and fragments make
// no sense on a base URL (the client appends its own paths) and are refused too.
// Throws a user-facing message on anything unusable.
export function normalizeNodeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('Enter a node URL.')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('That is not a valid URL.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Node URL must start with https:// or http://.')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Do not put credentials in the URL — the URL is stored unencrypted. Use the separate username/password fields; those are stored sealed.')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('A node URL must be a plain base URL — remove the query string / fragment.')
  }
  if (parsed.protocol === 'http:' && !isLocalOrPrivateHost(parsed.hostname)) {
    throw new Error('A remote node must use https://. Plain http:// is only allowed for localhost, a private/LAN address, or a .onion (Tor) host — otherwise the connection and any node credentials would travel unencrypted.')
  }
  return trimmed.replace(/\/+$/, '')
}
