import type { BlobStore, Sealer } from '../wallet/meta'

// HTTP Basic-auth credentials for a self-hosted node, sealed at rest with the Vault's
// app-data key — the password is a secret, so it must never sit in the plain
// node.json. Global (like contacts): one credential for the own-node connection.
export interface NodeAuth {
  readonly user?: string
  readonly password: string
}

// A blob store that can also delete its file (FileVaultStorage satisfies it).
type SealedStore = BlobStore & { clear(): Promise<void> }

export class NodeAuthStore {
  // undefined = not loaded yet; null = loaded, none configured.
  private cache: NodeAuth | null | undefined = undefined

  constructor(
    private readonly store: SealedStore,
    private readonly sealer: Sealer,
  ) {}

  async load(): Promise<NodeAuth | null> {
    if (this.cache !== undefined) return this.cache
    const blob = await this.store.read()
    if (blob === null) {
      this.cache = null
      return null
    }
    this.cache = JSON.parse(await this.sealer.openData(blob)) as NodeAuth
    return this.cache
  }

  async save(auth: NodeAuth): Promise<void> {
    this.cache = auth
    await this.store.write(await this.sealer.sealData(JSON.stringify(auth)))
  }

  async clear(): Promise<void> {
    this.cache = null
    await this.store.clear()
  }

  // Drop the in-memory copy (on lock) without touching disk.
  reset(): void {
    this.cache = undefined
  }
}

// The `Authorization: Basic …` header value for a credential. The node ignores the
// username (it checks only the password), but a fronting proxy may use it.
export function basicAuthHeader(auth: NodeAuth): string {
  return `Basic ${Buffer.from(`${auth.user ?? ''}:${auth.password}`).toString('base64')}`
}
