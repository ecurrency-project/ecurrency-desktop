import { activeScheme, isValidAccountXpub, validateAddress, type Network } from '@qbitcoin/crypto'
import type { WatchInput } from '../../shared/protocol'
import { createAddressListSource, createDescriptorAddressSource, type AddressSource } from './AddressSource'
import type { BlobStore, Sealer } from './meta'
import { parseWatchDescriptor, WATCH_DESCRIPTOR_KIND, type WatchDescriptor } from './watchDescriptor'

// What a watch wallet needs to follow the chain without any key: either a descriptor
// (classical xpub + the source wallet's Falcon address list) or a bare list of
// addresses pasted by the user. Stored sealed at rest with the app-data key.
export type StoredWatchSource =
  | { readonly type: 'descriptor'; readonly descriptor: WatchDescriptor }
  | { readonly type: 'addresses'; readonly network: Network; readonly addresses: readonly string[] }

// Validate + normalize a user's watch input into the stored form for `network`.
// Throws with a human-readable message on invalid input.
export function parseWatchInput(input: WatchInput, network: Network): StoredWatchSource {
  switch (input.kind) {
    case 'descriptor': {
      const descriptor = parseWatchDescriptor(input.text)
      if (descriptor.network !== network) {
        throw new Error(`Watch descriptor is for ${descriptor.network}, not ${network}.`)
      }
      return { type: 'descriptor', descriptor }
    }
    case 'xpub': {
      const xpub = input.xpub.trim()
      if (!isValidAccountXpub(xpub)) throw new Error('That does not look like a valid account xpub.')
      // A bare xpub watches only the classical branch (no Falcon addresses). The
      // xpub itself carries no scheme information, so it's filed under the active
      // scheme — for a watch wallet the tag is informational (never signed).
      return {
        type: 'descriptor',
        descriptor: {
          kind: WATCH_DESCRIPTOR_KIND,
          version: 2,
          network,
          schemes: [{ scheme: activeScheme().id, classicalXpub: xpub, falcon: { receive: [], change: [] } }],
        },
      }
    }
    case 'addresses': {
      const addresses = input.addresses.map((a) => a.trim()).filter((a) => a !== '')
      if (addresses.length === 0) throw new Error('Provide at least one address to watch.')
      const bad = addresses.find((a) => !validateAddress(a, network))
      if (bad !== undefined) throw new Error(`Not a valid ${network} address: ${bad}`)
      return { type: 'addresses', network, addresses }
    }
  }
}

// Build the AddressSource for a stored watch source.
export function addressSourceFromStored(stored: StoredWatchSource): AddressSource {
  return stored.type === 'descriptor' ? createDescriptorAddressSource(stored.descriptor) : createAddressListSource(stored.addresses)
}

// Sealed-at-rest store for a watch wallet's source (one per wallet, under its dir).
// Public derivation data, so encrypting it is for privacy at rest, not secrecy of keys.
export class WatchSourceStore {
  private cache: StoredWatchSource | null = null

  constructor(
    private readonly store: BlobStore,
    private readonly sealer: Sealer,
  ) {}

  async load(): Promise<StoredWatchSource | null> {
    if (this.cache !== null) return this.cache
    const blob = await this.store.read()
    if (blob === null) return null
    this.cache = JSON.parse(await this.sealer.openData(blob)) as StoredWatchSource
    return this.cache
  }

  async save(source: StoredWatchSource): Promise<void> {
    this.cache = source
    await this.store.write(await this.sealer.sealData(JSON.stringify(source)))
  }

  reset(): void {
    this.cache = null
  }
}

// An AddressSource that lazily loads the (async, sealed) stored source on first use,
// so a wallet session can be assembled synchronously. The resolved source is reused
// for the session; reset() drops it (on lock or wallet switch).
export function createWatchAddressSource(load: () => Promise<StoredWatchSource | null>): AddressSource {
  let inner: AddressSource | null = null
  const resolve = async (): Promise<AddressSource> => {
    if (inner === null) {
      const stored = await load()
      if (stored === null) throw new Error('Watch source is missing or could not be opened.')
      inner = addressSourceFromStored(stored)
    }
    return inner
  }
  return {
    branches: async () => (await resolve()).branches(),
    reset: () => {
      inner = null
    },
  }
}
