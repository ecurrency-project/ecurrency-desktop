import { masterKeyFromSeed, mnemonicToSeed, validateMnemonic, type HDKey, type Network } from '@qbtc/crypto'
import { SensitiveSessionError } from '../../shared/privacy'
import type { WalletBackup, WalletPublicData } from '../../shared/protocol'
import { DEFAULT_WALLET_ID, type WalletRegistry } from '../vault/registry'
import { KeyStore } from './keyStore'
import { importedKeyFromStored } from './keyWallet'
import { WalletMetaStore, type BlobStore, type Sealer } from './meta'
import { SeedStore } from './seedStore'
import { buildSeedWatchDescriptor, encodeWatchDescriptor } from './watchDescriptor'
import { parseWatchInput, WatchSourceStore } from './watchSource'

interface BackupVault extends Sealer {
  revealMnemonic(password: string): Promise<string>
  getMasterKey(): HDKey
  captureBackupContext(): () => void
}
type BackupFile = 'seed.json' | 'key.json' | 'watch.json' | 'walletmeta.json'
type Check = () => void

// Every read belongs to one wallet and one uninterrupted authentication context.
// Plaintext only lives in this operation and the explicitly requested response.
export class WalletBackupService {
  private generation = 0
  constructor(
    private readonly vault: BackupVault,
    private readonly registry: Pick<WalletRegistry, 'get' | 'getActiveId'>,
    private readonly network: Network,
    private readonly storage: (walletId: string, file: BackupFile) => BlobStore,
  ) {}

  invalidate(): void { this.generation++ }

  private context(walletId: string, permission: Check) {
    permission()
    if (!/^[a-zA-Z0-9_-]+$/.test(walletId)) throw new Error('Invalid wallet identifier.')
    const entry = this.registry.get(walletId)
    if (!entry || entry.id !== this.registry.getActiveId()) throw new Error('Select this wallet before opening its backup.')
    const generation = this.generation
    const vaultCheck = this.vault.captureBackupContext()
    const check = (): void => {
      permission()
      vaultCheck()
      if (generation !== this.generation || this.registry.getActiveId() !== entry.id || this.registry.get(entry.id)?.kind !== entry.kind) {
        throw new SensitiveSessionError()
      }
    }
    check()
    return { id: entry.id, kind: entry.kind, label: entry.label, check }
  }

  private async read<T>(id: string, file: BackupFile, check: Check, create: (store: BlobStore, sealer: Sealer) => { load(): Promise<T>; reset?(): void }): Promise<T> {
    check()
    const disk = this.storage(id, file)
    const readOnly = async (): Promise<never> => { throw new Error('Backup reads cannot write data.') }
    const store = create({
      read: async () => { check(); const blob = await disk.read(); check(); return blob },
      write: readOnly,
    }, {
      openData: async (blob) => { check(); const text = await this.vault.openData(blob); check(); return text },
      sealData: readOnly,
    })
    try {
      const data = await store.load()
      check()
      return data
    } catch {
      check()
      // JSON/codec errors can contain fragments of the plaintext. Never bridge them.
      throw new Error('Could not read this wallet’s backup data.')
    } finally { store.reset?.() }
  }

  async reveal(walletId: string, password: string, permission: Check): Promise<WalletBackup> {
    const { id, kind, check } = this.context(walletId, permission)
    if (kind !== 'seed' && kind !== 'key') throw new Error('This wallet has no private keys.')
    if (id === DEFAULT_WALLET_ID) {
      if (kind !== 'seed') throw new Error('Invalid primary wallet type.')
      const mnemonic = await this.vault.revealMnemonic(password)
      check()
      return { walletId: id, kind: 'seed', mnemonic }
    }

    // Vault 1.1.0 has no verifyPassword. This call uses its shared throttle;
    // discard the primary mnemonic in main instead of sending it to the UI.
    await this.vault.revealMnemonic(password)
    check()
    if (kind === 'seed') {
      const seed = await this.read(id, 'seed.json', check, (disk, sealer) => new SeedStore(disk, sealer))
      check()
      if (!seed || typeof seed.mnemonic !== 'string' || !validateMnemonic(seed.mnemonic) || (seed.passphrase !== undefined && typeof seed.passphrase !== 'string')) {
        throw new Error('This wallet’s recovery phrase is missing or invalid.')
      }
      return { walletId: id, kind, mnemonic: seed.mnemonic, ...(seed.passphrase !== undefined ? { passphrase: seed.passphrase } : {}) }
    }
    const stored = await this.read(id, 'key.json', check, (disk, sealer) => new KeyStore(disk, sealer))
    check()
    if (!stored || typeof stored.wif !== 'string' || typeof stored.address !== 'string' || !stored.address || !['ecdsa', 'schnorr', 'falcon512'].includes(stored.algo)) {
      throw new Error('This wallet’s private key is missing or invalid.')
    }
    try {
      const key = await importedKeyFromStored(stored, this.network)
      try {
        check()
        return { walletId: id, kind, wif: stored.wif, algo: key.algo, address: key.address, network: this.network }
      } finally { key.privateKey.fill(0) }
    } catch {
      check()
      throw new Error('This wallet’s private key data is inconsistent.')
    }
  }

  async exportPublic(walletId: string): Promise<WalletPublicData> {
    const { id, kind, label, check } = this.context(walletId, () => {})
    if (kind === 'key') throw new Error('This wallet has one address and no watch descriptor.')
    if (kind === 'watch') {
      const source = await this.read(id, 'watch.json', check, (disk, sealer) => new WatchSourceStore(disk, sealer))
      check()
      try {
        if (source?.type === 'descriptor') {
          const validated = parseWatchInput({ kind: 'descriptor', text: encodeWatchDescriptor(source.descriptor) }, this.network)
          if (validated.type === 'descriptor') return { walletId: id, kind: 'descriptor', text: encodeWatchDescriptor(validated.descriptor), network: this.network }
        }
        if (source?.type === 'addresses' && source.network === this.network) {
          const validated = parseWatchInput({ kind: 'addresses', addresses: source.addresses }, this.network)
          if (validated.type === 'addresses') return { walletId: id, kind: 'addresses', text: validated.addresses.join('\n'), network: this.network }
        }
      } catch { /* Do not expose an invalid stored value in an error. */ }
      throw new Error('This wallet’s public data is missing or invalid.')
    }
    let master: HDKey
    if (id === DEFAULT_WALLET_ID) master = this.vault.getMasterKey()
    else {
      const seed = await this.read(id, 'seed.json', check, (disk, sealer) => new SeedStore(disk, sealer))
      if (!seed || typeof seed.mnemonic !== 'string' || !validateMnemonic(seed.mnemonic) || (seed.passphrase !== undefined && typeof seed.passphrase !== 'string')) throw new Error('This wallet’s recovery data is invalid.')
      const bytes = mnemonicToSeed(seed.mnemonic, seed.passphrase)
      try { master = masterKeyFromSeed(bytes) } finally { bytes.fill(0) }
    }
    try {
      check()
      const meta = await this.read(id, 'walletmeta.json', check, (disk, sealer) => new WalletMetaStore(disk, sealer))
      check()
      const descriptor = await buildSeedWatchDescriptor({ master, meta, network: this.network, label, check })
      check()
      return { walletId: id, kind: 'descriptor', text: encodeWatchDescriptor(descriptor), network: this.network }
    } finally { master.wipePrivateData() }
  }
}
