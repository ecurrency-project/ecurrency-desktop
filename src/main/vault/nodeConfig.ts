import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Node-selection configuration for the Network card.
//
// A small PLAIN JSON file (like the wallet registry): which backend slot is active
// ('public', 'own' or one of the user-added public nodes), the user's own-node URL
// if set, the community ("custom") node list, and the Tor flag. It holds no key
// material and must be readable at startup so the chain client can be built before
// any unlock. Electrum is not persisted yet (its slot is not wired).
//
// Custom nodes are PUBLIC esplora instances anyone can host — unlike the own
// node they carry no credentials and participate in failover alongside the
// bundled endpoints. The wallet talks to every backend over the same Esplora
// REST dialect; there is no protocol choice to store.

export type StoredNodeKind = 'public' | 'own' | 'custom'

export interface CustomNodeStored {
  readonly url: string
  /** Display label; the URL's host is shown when absent. */
  readonly name?: string
}

export interface NodeSettingsStored {
  readonly selected: StoredNodeKind
  /** Which bundled node is primary when `selected === 'public'`; absent means
   *  "the first one" (the brand may ship several, or none at all). */
  readonly selectedPublicUrl?: string
  /** Which custom node is active when `selected === 'custom'`. */
  readonly selectedCustomUrl?: string
  readonly ownUrl?: string
  readonly tor: boolean
  readonly customNodes: readonly CustomNodeStored[]
}

interface NodeConfigFile {
  readonly version: number
  readonly selected: StoredNodeKind
  readonly selectedPublicUrl?: string
  readonly selectedCustomUrl?: string
  readonly ownUrl?: string
  readonly tor: boolean
  readonly customNodes: readonly CustomNodeStored[]
}

const NODE_CONFIG_VERSION = 1

export class NodeConfigStore {
  private data: NodeConfigFile

  /**
   * @param file        path of the plain JSON config
   * @param publicUrls  URLs of the endpoints this BUILD bundles for its network
   *                    (from DEFAULT_NODES). The store validates the primary
   *                    pick against them and forgets a pick that a release has
   *                    since dropped from the list.
   */
  constructor(
    private readonly file: string,
    private readonly publicUrls: readonly string[] = [],
  ) {
    this.data = this.read()
  }

  getSettings(): NodeSettingsStored {
    const s: { selected: StoredNodeKind; selectedPublicUrl?: string; selectedCustomUrl?: string; ownUrl?: string; tor: boolean; customNodes: readonly CustomNodeStored[] } = {
      selected: this.data.selected,
      tor: this.data.tor,
      customNodes: this.data.customNodes,
    }
    if (this.data.selectedPublicUrl !== undefined) s.selectedPublicUrl = this.data.selectedPublicUrl
    if (this.data.selectedCustomUrl !== undefined) s.selectedCustomUrl = this.data.selectedCustomUrl
    if (this.data.ownUrl !== undefined) s.ownUrl = this.data.ownUrl
    return s
  }

  /**
   * Activate a slot. 'custom' requires the URL of a stored custom node;
   * 'public' takes the URL of a bundled node, or none to mean "the first one"
   * (which is also what a build that bundles a single node always resolves to).
   */
  setSelected(kind: StoredNodeKind, url?: string): void {
    if (kind === 'custom') {
      if (url === undefined || !this.data.customNodes.some((c) => c.url === url)) {
        throw new Error('That node is not in the list.')
      }
      this.persist({ ...this.data, selected: 'custom', selectedCustomUrl: url })
      return
    }
    if (kind === 'public' && url !== undefined) {
      if (!this.publicUrls.includes(url)) throw new Error('That node is not in the list.')
      this.persist({ ...this.data, selected: 'public', selectedPublicUrl: url })
      return
    }
    // Leaving a slot keeps its memo around, harmlessly: coming back to
    // 'public' or 'custom' restores the node the user had picked there.
    this.persist({ ...this.data, selected: kind })
  }

  /** Add a public (community) node, or rename it when the URL is already listed. */
  addCustomNode(url: string, name?: string): void {
    const entry: CustomNodeStored = name !== undefined && name.trim() !== '' ? { url, name: name.trim() } : { url }
    const rest = this.data.customNodes.filter((c) => c.url !== url)
    this.persist({ ...this.data, customNodes: [...rest, entry] })
  }

  /** Remove a custom node; if it was the active slot, fall back to the public node. */
  removeCustomNode(url: string): void {
    const customNodes = this.data.customNodes.filter((c) => c.url !== url)
    const wasActive = this.data.selected === 'custom' && this.data.selectedCustomUrl === url
    const next: NodeConfigFile = { ...this.data, customNodes, selected: wasActive ? 'public' : this.data.selected }
    if (wasActive) {
      const { selectedCustomUrl: _dropped, ...rest } = next
      this.persist(rest as NodeConfigFile)
      return
    }
    this.persist(next)
  }

  setOwnUrl(url: string): void {
    this.persist({ ...this.data, ownUrl: url })
  }

  // Drop the own-node URL; if it was the active slot, fall back to the public node.
  // Custom nodes and the selected-custom memo are unrelated and survive.
  clearOwnUrl(): void {
    const { ownUrl: _dropped, ...rest } = this.data
    this.persist({ ...rest, selected: this.data.selected === 'own' ? 'public' : this.data.selected })
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
      const p = JSON.parse(readFileSync(this.file, 'utf8')) as {
        selected?: unknown
        selectedPublicUrl?: unknown
        selectedCustomUrl?: unknown
        ownUrl?: unknown
        tor?: unknown
        customNodes?: unknown
      }
      const ownUrl = typeof p.ownUrl === 'string' && p.ownUrl.length > 0 ? p.ownUrl : undefined
      // Tolerant parse: malformed entries are dropped, not fatal (a broken
      // config must never strand the wallet without a backend).
      const customNodes: CustomNodeStored[] = Array.isArray(p.customNodes)
        ? p.customNodes.flatMap((c: unknown): CustomNodeStored[] => {
            if (typeof c !== 'object' || c === null) return []
            const { url, name } = c as { url?: unknown; name?: unknown }
            if (typeof url !== 'string' || url.length === 0) return []
            return [typeof name === 'string' && name.length > 0 ? { url, name } : { url }]
          })
        : []
      const selectedCustomUrl =
        typeof p.selectedCustomUrl === 'string' && customNodes.some((c) => c.url === p.selectedCustomUrl)
          ? p.selectedCustomUrl
          : undefined
      // A primary pick that this build no longer bundles (the brand's node list
      // changed in a release) is forgotten, not honoured: the pool would drop
      // the URL anyway, and "first bundled node" is the right answer then.
      const selectedPublicUrl =
        typeof p.selectedPublicUrl === 'string' && this.publicUrls.includes(p.selectedPublicUrl)
          ? p.selectedPublicUrl
          : undefined
      // Each slot only makes sense with its target present; otherwise fall
      // back to the bundled public node.
      const selected: StoredNodeKind =
        p.selected === 'own' && ownUrl !== undefined
          ? 'own'
          : p.selected === 'custom' && selectedCustomUrl !== undefined
            ? 'custom'
            : 'public'
      const base: NodeConfigFile = { version: NODE_CONFIG_VERSION, selected, tor: p.tor === true, customNodes }
      return {
        ...base,
        ...(ownUrl !== undefined ? { ownUrl } : {}),
        ...(selectedPublicUrl !== undefined ? { selectedPublicUrl } : {}),
        ...(selectedCustomUrl !== undefined ? { selectedCustomUrl } : {}),
      }
    } catch {
      return { version: NODE_CONFIG_VERSION, selected: 'public', tor: false, customNodes: [] }
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
