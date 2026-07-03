import type { Contact } from '../../shared/protocol'
import type { BlobStore, Sealer } from './meta'

// The address book: name ↔ address entries, sealed at rest with the seed-derived
// key (never leaves the device). Addresses are validated on add (injected so the
// service stays free of crypto and is unit-testable). Keyed by address, so adding
// the same address renames it. Cached while unlocked; dropped on lock.
export class ContactService {
  private cache: Record<string, string> | null = null

  constructor(
    private readonly store: BlobStore,
    private readonly sealer: Sealer,
    private readonly isValidAddress: (address: string) => boolean,
  ) {}

  async list(): Promise<Contact[]> {
    const map = await this.load()
    return Object.entries(map)
      .map(([address, name]) => ({ address, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async add(name: string, address: string): Promise<void> {
    const cleanName = name.trim()
    const cleanAddress = address.trim()
    if (cleanName === '') throw new Error('Contact name is required.')
    if (!this.isValidAddress(cleanAddress)) throw new Error('That does not look like a valid address.')
    const map = { ...(await this.load()) }
    map[cleanAddress] = cleanName
    await this.persist(map)
  }

  async remove(address: string): Promise<void> {
    const map = { ...(await this.load()) }
    if (!(address in map)) return
    delete map[address]
    await this.persist(map)
  }

  /** Drop the cache (e.g. on lock/destroy). */
  reset(): void {
    this.cache = null
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache !== null) return this.cache
    const blob = await this.store.read()
    this.cache = blob === null ? {} : (JSON.parse(await this.sealer.openData(blob)) as Record<string, string>)
    return this.cache
  }

  private async persist(map: Record<string, string>): Promise<void> {
    this.cache = map
    await this.store.write(await this.sealer.sealData(JSON.stringify(map)))
  }
}
