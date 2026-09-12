import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { btcEsploraDefaultsFor, BtcEsploraClient, ChainClient, type NodeEndpoint } from '@qbtc/chain'
import { generateMnemonic, hash256, isSchnorrEnabled, masterKeyFromSeed, mnemonicToSeed, parseAccountXpub, toHex, validateMnemonic, type HDKey, type Network } from '@qbtc/crypto'
import { Vault } from '@qbitcoin/vault'
import { addressFromScripthash, addressFromXpub, decodeAddress, decodeWif, DOWNGRADE, exportAccountXpub, UPGRADE, validateAddress } from '../brand/crypto'
import { defaultNodesFor } from '../brand/nodes'
import { PROFILE } from '../brand/profile'
import type { AddressAlgo, KeyInspection, NodeKind, NodeSettings, NodeStatus, SendPreview, SendResult, UpgradeConvertRequest, UpgradePlanView, VaultStatus, WalletInfo, WatchInput } from '../../shared/protocol'
import { deriveClassicalAddress } from '../wallet/addresses'
import { AddressService, type WalletVault } from '../wallet/AddressService'
import { createSeedAddressSource, type AddressSource } from '../wallet/AddressSource'
import { KeyStore } from '../wallet/keyStore'
import { createKeyAddressSource, importedKeyFromStored, inspectWifKey, keyReceiveOps, signUnsignedTxWithKey, type ImportedKey } from '../wallet/keyWallet'
import { SeedStore } from '../wallet/seedStore'
import { createSweepSession, type SweepSession } from '../wallet/sweep'
import { ChainService } from '../wallet/ChainService'
import { CoinService } from '../wallet/CoinService'
import { CoinMetaStore } from '../wallet/coinMeta'
import { ContactService } from '../wallet/ContactService'
import { WalletMetaStore } from '../wallet/meta'
import { SendService } from '../wallet/SendService'
import { deriveInputKeypair, signUnsignedTx } from '../wallet/signTx'
import { SnapshotStore } from '../wallet/snapshot'
import { gatherFromActive, type GatheredUtxo } from '../wallet/spendable'
import { UpgradeService, type ConvertPlan, type ConvertRequest } from '../wallet/UpgradeService'
import { DowngradeService, type ReclaimKeyCell } from '../wallet/DowngradeService'
import { DowngradeMetaStore } from '../wallet/downgradeStore'
import { UpgradeMetaStore } from '../wallet/upgradeStore'
import { buildSeedWatchDescriptor, descriptorSchemes, encodeWatchDescriptor } from '../wallet/watchDescriptor'
import { createWatchAddressSource, parseWatchInput, WatchSourceStore } from '../wallet/watchSource'
import { dataRootFor, readNetworkProfile, writeNetworkProfile } from './networkProfile'
import { basicAuthHeader, NodeAuthStore, type NodeAuth } from './nodeAuth'
import { NodeConfigStore, normalizeNodeUrl, type NodeSettingsStored, type StoredNodeKind } from './nodeConfig'
import { buildEndpoints, primaryPublicUrl } from './nodePool'
import { VaultOrchestrator, type AddressOps, type ChainOps, type CoinOps, type SendOps } from './orchestrator'
import { DEFAULT_WALLET_ID, migrateLegacyLayout, walletDir, WalletRegistry } from './registry'
import { FileVaultStorage } from './storage'

// Auto-lock after 5 minutes of inactivity. The Vault owns the timer; in a
// long-lived main process its setTimeout is reliable (no service-worker death).
const AUTO_LOCK_MS = 5 * 60 * 1000


export interface WalletCore {
  readonly vault: Vault
  readonly orchestrator: VaultOrchestrator
}

// The per-wallet services that sit behind the orchestrator. Rebuilt whenever the
// active wallet changes; the Vault, address book and registry are app-global and
// outlive a switch.
interface WalletSession {
  readonly addresses: AddressOps
  readonly chain: ChainOps
  readonly send: SendOps
  readonly coins: CoinOps
  /** BTC→native upgrade flow; null on brands without it or key-free wallets. */
  readonly upgrade: UpgradeService | null
  /** Native→BTC downgrade flow; null on brands without it or key-free wallets. */
  readonly downgrade: DowngradeService | null
  /** Warm discovery + the spend pool in the background (on unlock or after a switch). */
  readonly prewarm: () => void
  /** Drop cached/held state (on lock, or when this session is replaced). */
  readonly reset: () => void
}

// Build the Vault (sole owner of the decrypted seed) and the orchestrator that fronts
// the active wallet's services. Call after the app is ready — it resolves userData.
export function createWalletCore(): WalletCore {
  // Which network this PROCESS runs on — decided once, at startup, by the
  // profile file in the real userData root. Switching networks writes the
  // profile and relaunches; a session is never multi-network.
  const userDataBase = app.getPath('userData')
  const NETWORK = readNetworkProfile(userDataBase)
  // Everything below lives under the network-scoped root: mainnet keeps the
  // historical flat layout (paths must not move — shipped wallets), testnet
  // is an isolated subtree.
  const userData = dataRootFor(userDataBase, NETWORK)
  // Pre-multi-wallet installs kept their files flat under userData; migrate them under
  // wallets/<id>/ once, then resolve the registry. The address book stays global.
  migrateLegacyLayout(userData)
  const registry = new WalletRegistry(join(userData, 'wallets.json'))

  // The Vault owns the (single) decrypted seed and provides the app-data key that
  // seals every wallet's at-rest stores; it lives at the default wallet's path and
  // outlives active-wallet switches. (v1: one seed wallet; watch wallets reuse this
  // key for their sealed public data.)
  const vault = new Vault(new FileVaultStorage(join(walletDir(userData, DEFAULT_WALLET_ID), 'vault.json')), { autoLockMs: AUTO_LOCK_MS, appDataInfo: PROFILE.appDataInfo })

  // The public endpoints this build ships for its network (a brand value; may
  // be empty while a network is unlaunched).
  const publicEndpoints = defaultNodesFor(NETWORK)
  // Node selection (plain config, like the registry) — read at startup so the chain
  // client can be built before any unlock. Slots: a bundled public node, the user's
  // own Esplora REST node (same dialect, different URL), or a community node they
  // added. The store is given the bundled URLs so it can validate — and forget —
  // the primary pick.
  const nodeConfig = new NodeConfigStore(
    join(userData, 'node.json'),
    publicEndpoints.map((e) => e.url),
  )
  // Optional HTTP Basic auth for a self-hosted node behind a proxy. The password is a
  // secret, so it's sealed (not in the plain node.json); held in memory only while
  // unlocked. The reference node leaves /api/* open, so this is opt-in.
  const nodeAuthStore = new NodeAuthStore(new FileVaultStorage(join(userData, 'nodeauth.json')), vault)
  let ownAuth: NodeAuth | null = null

  const endpointsFor = (s: NodeSettingsStored): NodeEndpoint[] => buildEndpoints(s, publicEndpoints, NETWORK)
  // Build a client for the current settings, attaching Basic auth only for the own node
  // (and only when a credential is loaded — i.e. unlocked).
  const buildChainClient = (): ChainClient => {
    const s = nodeConfig.getSettings()
    const authHeader = s.selected === 'own' && ownAuth !== null ? basicAuthHeader(ownAuth) : undefined
    return new ChainClient({ network: NETWORK, endpoints: endpointsFor(s), transport: authHeader !== undefined ? { authHeader } : undefined })
  }
  // Reassigned when the user switches slot / sets a node / unlocks; buildSession reads
  // it afresh, so rebuilding the active session adopts the new client.
  let chainClient = buildChainClient()

  // The address book is global — shared across wallets, not per-wallet.
  const contacts = new ContactService(
    new FileVaultStorage(join(userData, 'contacts.json')),
    vault,
    (address) => validateAddress(address, NETWORK),
  )

  // Assemble the per-wallet services for one wallet id. A seed wallet derives its
  // addresses from the master key and can sign; a watch wallet follows a key-free
  // source (xpub / address list) and refuses to sign. Sealed stores use the Vault's
  // app-data key either way.
  const buildSession = (walletId: string): WalletSession => {
    const dir = walletDir(userData, walletId)
    const wf = (name: string): string => join(dir, name)
    const kind = registry.get(walletId)?.kind ?? 'seed'

    const coinMeta = new CoinMetaStore(new FileVaultStorage(wf('coinmeta.json')), vault)
    // Transaction labels reuse the same sealed key→{label} store, keyed by txid.
    const txLabels = new CoinMetaStore(new FileVaultStorage(wf('txlabels.json')), vault)
    // Last-known read-model, sealed like the metadata stores, for instant unlock/restart.
    const snapshotStore = new SnapshotStore(new FileVaultStorage(wf('snapshot.json')), vault)

    // Address source, receive ops and signing capability are what differ by kind.
    let addressSource: AddressSource
    let addresses: AddressOps
    let seedAddrSvc: AddressService | null = null
    // Upgrade flow: needs seed derivation + a brand upgrade config.
    let upgradeSvc: UpgradeService | null = null
    // Master-key provider for a seed wallet (used by its address source, AddressService
    // and signing). Null for watch and key wallets.
    let seedMasterKey: (() => Promise<HDKey>) | null = null
    // Imported-key provider for a key wallet. Null for seed and watch wallets.
    let keyProvider: (() => Promise<ImportedKey>) | null = null
    let resetSource: () => void
    if (kind === 'seed') {
      const metaStore = new WalletMetaStore(new FileVaultStorage(wf('walletmeta.json')), vault)
      // The default wallet derives from the primary Vault directly; an imported seed
      // wallet opens its sealed seed lazily and caches the derived master key for the
      // session (cleared on lock/switch).
      const seedStore = walletId === DEFAULT_WALLET_ID ? null : new SeedStore(new FileVaultStorage(wf('seed.json')), vault)
      let cachedKey: HDKey | null = null
      const getMasterKey = async (): Promise<HDKey> => {
        if (seedStore === null) return vault.getMasterKey()
        if (cachedKey === null) {
          const stored = await seedStore.load()
          if (stored === null) throw new Error('Seed for this wallet is missing or could not be opened.')
          cachedKey = masterKeyFromSeed(mnemonicToSeed(stored.mnemonic, stored.passphrase))
        }
        return cachedKey
      }
      seedMasterKey = getMasterKey
      const keyVault: WalletVault = { getMasterKey, on: (l) => vault.on(l) }
      const source = createSeedAddressSource({ getMasterKey, metaStore, network: NETWORK })
      seedAddrSvc = new AddressService(keyVault, metaStore, NETWORK)
      if (UPGRADE !== null) {
        upgradeSvc = new UpgradeService(
          keyVault,
          new UpgradeMetaStore(new FileVaultStorage(wf('upgrade.json')), vault),
          new BtcEsploraClient({ baseUrl: btcEsploraDefaultsFor(NETWORK)[0]! }),
          UPGRADE[NETWORK],
          NETWORK,
        )
      }
      addressSource = source
      addresses = seedAddrSvc
      resetSource = () => {
        source.reset()
        seedStore?.reset()
        cachedKey = null
      }
    } else if (kind === 'key') {
      // A single imported key: one fixed address, signs with that key. The
      // materialized key (private bytes included) is cached for the session
      // and wiped on lock/switch.
      const keyStore = new KeyStore(new FileVaultStorage(wf('key.json')), vault)
      let cachedImported: ImportedKey | null = null
      const getKey = async (): Promise<ImportedKey> => {
        if (cachedImported === null) {
          const stored = await keyStore.load()
          if (stored === null) throw new Error('The key for this wallet is missing or could not be opened.')
          cachedImported = await importedKeyFromStored(stored, NETWORK)
        }
        return cachedImported
      }
      keyProvider = getKey
      addressSource = createKeyAddressSource(getKey)
      addresses = keyReceiveOps(getKey)
      resetSource = () => {
        cachedImported?.privateKey.fill(0)
        cachedImported = null
        keyStore.reset()
      }
    } else {
      const watchStore = new WatchSourceStore(new FileVaultStorage(wf('watch.json')), vault)
      const source = createWatchAddressSource(() => watchStore.load())
      addressSource = source
      addresses = watchReceiveOps(source)
      resetSource = () => {
        source.reset()
        watchStore.reset()
      }
    }

    // The spend pool (every branch's UTXOs) is the expensive read. A 30s memo
    // de-duplicates the Send screen's concurrent callers (coin list + live fee); a
    // spend busts it via onSpent, and incoming coins surface on the next refresh.
    const GATHER_TTL_MS = 30_000
    let gatherMemo: { at: number; promise: Promise<GatheredUtxo[]> } | null = null
    const gatherAll = (): Promise<GatheredUtxo[]> => {
      if (gatherMemo !== null && Date.now() - gatherMemo.at < GATHER_TTL_MS) return gatherMemo.promise
      const at = Date.now()
      // Reuse the chain service's shared, de-duplicated discovery — no second gap-scan.
      const promise = (async () => gatherFromActive(await chain.spendableAddresses(), chainClient))()
      gatherMemo = { at, promise }
      promise.catch(() => {
        if (gatherMemo?.promise === promise) gatherMemo = null
      })
      return promise
    }
    const bustGather = (): void => {
      gatherMemo = null
    }

    const chain = new ChainService(chainClient, addressSource.branches, { btcNetwork: NETWORK })
    const coins = new CoinService({
      gather: gatherAll,
      tipHeight: async () => (await chainClient.getBlockchainInfo()).tipHeight,
      meta: coinMeta,
    })

    // Seed and key wallets sign; a watch wallet's send paths refuse (no keys).
    const frozenSet = async (): Promise<ReadonlySet<string>> => {
      const meta = await coinMeta.load()
      return new Set(
        Object.entries(meta)
          .filter(([, m]) => m.frozen === true)
          .map(([outpoint]) => outpoint),
      )
    }
    const broadcast = async (rawHex: string): Promise<string> => (await chainClient.broadcastTransaction(rawHex)).txid
    let sendSvc: SendService | null = null
    if (seedAddrSvc !== null && seedMasterKey !== null) {
      const sa = seedAddrSvc
      const signWith = seedMasterKey
      sendSvc = new SendService({
        gather: gatherAll,
        feeRate: async () => (await chain.estimateFee()).medium,
        frozen: frozenSet,
        getChangeAddress: () => sa.getChangeAddress(),
        getPqChangeAddress: () => sa.getPqChangeAddress(),
        advanceChange: (algo) => (algo === 'falcon512' ? sa.advancePqChange() : sa.advanceChange()),
        sign: async (unsigned) => signUnsignedTx(unsigned, await signWith(), NETWORK),
        broadcast,
        // A spend changes the UTXO set, so drop the memoised pool immediately.
        onSpent: bustGather,
      })
    } else if (keyProvider !== null) {
      const getKey = keyProvider
      const ownAddress = async (): Promise<string> => (await getKey()).address
      sendSvc = new SendService({
        gather: gatherAll,
        feeRate: async () => (await chain.estimateFee()).medium,
        frozen: frozenSet,
        // No derivation on a key wallet: change (either branch) returns to its
        // own single address, and there is no index to advance. Address reuse
        // is the accepted trade-off of single-key wallets.
        getChangeAddress: ownAddress,
        getPqChangeAddress: ownAddress,
        advanceChange: async () => undefined,
        sign: async (unsigned) => signUnsignedTxWithKey(unsigned, await getKey(), NETWORK),
        broadcast,
        onSpent: bustGather,
      })
    }
    const send: SendOps = sendSvc ?? watchOnlySend()

    // Downgrade flow: seed wallets only (needs per-input derivation for the
    // reclaim key), gated on the brand's DOWNGRADE consensus params.
    let downgradeSvc: DowngradeService | null = null
    if (DOWNGRADE !== null && seedAddrSvc !== null && seedMasterKey !== null) {
      const cfg = DOWNGRADE[NETWORK]
      const freezePubkeys = cfg.freezePubkeysHex.map((hex) => Uint8Array.from(Buffer.from(hex, 'hex')))
      const legacyLockPubkey =
        cfg.legacyLockPubkeyHex !== undefined ? Uint8Array.from(Buffer.from(cfg.legacyLockPubkeyHex, 'hex')) : undefined
      const sa = seedAddrSvc
      const signWith = seedMasterKey
      // Cells for covenant rescans: every issued key plus a small lookahead,
      // as { derivation, hash256(pubkey) }. Each PQ cell costs a WASM keygen,
      // so the list is cached until the issued counters move.
      const CELL_LOOKAHEAD = 5
      let cellCache: { key: string; cells: readonly ReclaimKeyCell[] } | null = null
      const reclaimKeyCells = async (): Promise<readonly ReclaimKeyCell[]> => {
        const idx = await sa.issuedIndices()
        const cacheKey = [idx.receiveIndex, idx.changeIndex, idx.pqReceiveIndex, idx.pqChangeIndex].join(':')
        if (cellCache !== null && cellCache.key === cacheKey) return cellCache.cells
        const master = await signWith()
        const branches: { algo: 'ecdsa' | 'falcon512'; chain: 0 | 1; count: number }[] = [
          { algo: 'ecdsa', chain: 0, count: idx.receiveIndex + 1 + CELL_LOOKAHEAD },
          { algo: 'ecdsa', chain: 1, count: idx.changeIndex + 1 + CELL_LOOKAHEAD },
          { algo: 'falcon512', chain: 0, count: idx.pqReceiveIndex + 1 + CELL_LOOKAHEAD },
          { algo: 'falcon512', chain: 1, count: idx.pqChangeIndex + 1 + CELL_LOOKAHEAD },
        ]
        const cells: ReclaimKeyCell[] = []
        for (const b of branches) {
          for (let index = 0; index < b.count; index += 1) {
            const kp = await deriveInputKeypair(master, { account: 0, chain: b.chain, index, algo: b.algo }, NETWORK)
            kp.privateKey.fill(0)
            cells.push({ account: 0, chain: b.chain, index, algo: b.algo, reclaimIdHex: toHex(hash256(kp.publicKey)) })
          }
        }
        cellCache = { key: cacheKey, cells }
        return cells
      }
      downgradeSvc = new DowngradeService(
        {
          freezePubkeys,
          freezeSeconds: cfg.freezeSeconds,
          outputSeconds: cfg.outputSeconds,
          btcNetwork: NETWORK,
          ...(legacyLockPubkey !== undefined ? { legacyLockPubkey } : {}),
        },
        chainClient,
        new DowngradeMetaStore(new FileVaultStorage(wf('downgrade.json')), vault),
        {
          spendable: async () => {
            const frozen = await frozenSet()
            return (await gatherAll())
              .filter((u) => u.tokenId === undefined)
              .filter((u) => !frozen.has(`${u.txid}:${String(u.vout)}`))
          },
          covenantAddress: (scripthash) => addressFromScripthash(scripthash, NETWORK),
          reclaimKeyCells,
          changeAddressFor: (algo) => (algo === 'falcon512' ? sa.getPqChangeAddress() : sa.getChangeAddress()),
          feeRate: async () => (await chain.estimateFee()).medium,
          scripthashOf: (address) => decodeAddress(address).scripthash,
          inputPubkey: async (input) => {
            const kp = await deriveInputKeypair(await signWith(), input, NETWORK)
            kp.privateKey.fill(0)
            return kp.publicKey
          },
          inputKeypair: async (input) => deriveInputKeypair(await signWith(), input, NETWORK),
          signUnsigned: async (unsigned) => signUnsignedTx(unsigned, await signWith(), NETWORK),
        },
      )
    }

    // Chain ops = the chain reads plus a local overlay that attaches user labels to
    // history items and persists the read-model snapshot (both local-only).
    const chainOps: ChainOps = {
      getSummary: async () => {
        const summary = await chain.getSummary()
        void snapshotStore.merge({ summary }).catch(() => {})
        return summary
      },
      estimateFee: () => chain.estimateFee(),
      listTokens: async () => {
        const tokens = await chain.listTokens()
        void snapshotStore.merge({ tokens }).catch(() => {})
        return tokens
      },
      getHistory: async (pages) => {
        const [page, labels] = await Promise.all([chain.getHistory(pages), txLabels.load()])
        const withLabels = {
          ...page,
          items: page.items.map((it) => {
            const label = labels[it.txid]?.label
            return label !== undefined ? { ...it, label } : it
          }),
        }
        // Persist only the default single-page view as the instant-render snapshot.
        if (pages === undefined || pages <= 1) void snapshotStore.merge({ history: withLabels }).catch(() => {})
        return withLabels
      },
      setTxLabel: (txid, label) => txLabels.setLabel(txid, label),
      getTxDetail: (txid) => chain.getTxDetail(txid),
      getTxRaw: (txid) => chain.getTxRaw(txid),
      getSnapshot: () => snapshotStore.load(),
    }

    const prewarm = (): void => {
      void gatherAll().catch(() => {})
      void chain.prewarmAddressIndex().catch(() => {})
    }
    const reset = (): void => {
      sendSvc?.reset()
      coinMeta.reset()
      txLabels.reset()
      snapshotStore.reset()
      resetSource()
      bustGather()
    }

    return { addresses, chain: chainOps, send, coins, upgrade: upgradeSvc, downgrade: downgradeSvc, prewarm, reset }
  }

  let unlocked = false
  let active = buildSession(registry.getActiveId())

  // A representative address for display (the wallet's first classical receive). For a
  // seed wallet it's derived from the master key; for a watch wallet from its source
  // (xpub or the first listed address). Best-effort: returns undefined if locked or the
  // source can't be opened.
  const firstAddress = async (id: string): Promise<string | undefined> => {
    try {
      const entry = registry.get(id)
      if (entry === undefined) return undefined
      if (entry.kind === 'seed') {
        // The default wallet derives from the primary Vault; an imported seed wallet
        // from its own sealed seed.
        if (id === DEFAULT_WALLET_ID) {
          return deriveClassicalAddress(vault.getMasterKey(), { account: 0, chain: 0, index: 0, network: NETWORK })
        }
        const seed = await new SeedStore(new FileVaultStorage(join(walletDir(userData, id), 'seed.json')), vault).load()
        if (seed === null) return undefined
        return deriveClassicalAddress(masterKeyFromSeed(mnemonicToSeed(seed.mnemonic, seed.passphrase)), { account: 0, chain: 0, index: 0, network: NETWORK })
      }
      if (entry.kind === 'key') {
        // A key wallet's single address is persisted beside the sealed key.
        const stored = await new KeyStore(new FileVaultStorage(join(walletDir(userData, id), 'key.json')), vault).load()
        return stored?.address
      }
      const stored = await new WatchSourceStore(new FileVaultStorage(join(walletDir(userData, id), 'watch.json')), vault).load()
      if (stored === null) return undefined
      if (stored.type !== 'descriptor') return stored.addresses[0]
      // The first section is the descriptor's primary scheme (active-first on export).
      const [primary] = descriptorSchemes(stored.descriptor)
      return primary !== undefined ? addressFromXpub(parseAccountXpub(primary.classicalXpub), 0, 0, NETWORK) : undefined
    } catch {
      return undefined
    }
  }

  const listWallets = async (): Promise<readonly WalletInfo[]> => {
    const activeId = registry.getActiveId()
    return Promise.all(
      registry.list().map(async (e) => ({
        id: e.id,
        kind: e.kind,
        label: e.label,
        active: e.id === activeId,
        canSign: e.kind !== 'watch',
        removable: e.id !== DEFAULT_WALLET_ID,
        address: await firstAddress(e.id),
      })),
    )
  }

  // Drop the old session's caches, build the active one afresh, and warm it if unlocked.
  const rebuildActive = (): void => {
    active.reset()
    active = buildSession(registry.getActiveId())
    if (unlocked) active.prewarm()
  }

  const switchWallet = async (id: string): Promise<readonly WalletInfo[]> => {
    if (id !== registry.getActiveId()) {
      registry.setActive(id)
      rebuildActive()
    }
    return listWallets()
  }

  // Create a watch wallet from user input: validate + normalize, seal its source under
  // a fresh wallet dir, then register it. Sealing needs the app-data key, so the wallet
  // must be unlocked. Does not switch to it — the caller decides.
  const addWatchWallet = async (label: string, input: WatchInput): Promise<readonly WalletInfo[]> => {
    const stored = parseWatchInput(input, NETWORK)
    const id = randomUUID()
    const store = new WatchSourceStore(new FileVaultStorage(join(walletDir(userData, id), 'watch.json')), vault)
    await store.save(stored)
    const name = label.trim()
    registry.add({ id, kind: 'watch', label: name === '' ? 'Watch wallet' : name, createdAt: Date.now() })
    return listWallets()
  }

  // The master key of a SPECIFIC seed wallet: the primary derives from the Vault,
  // an imported one from its own sealed seed. Every per-wallet key read outside a
  // session MUST go through this — reading `vault.getMasterKey()` directly would
  // silently use the primary wallet's keys for whichever wallet is active.
  const openSeedMaster = async (id: string): Promise<HDKey> => {
    if (id === DEFAULT_WALLET_ID) return vault.getMasterKey()
    const seed = await new SeedStore(new FileVaultStorage(join(walletDir(userData, id), 'seed.json')), vault).load()
    if (seed === null) throw new Error('Seed for this wallet is missing or could not be opened.')
    return masterKeyFromSeed(mnemonicToSeed(seed.mnemonic, seed.passphrase))
  }

  // The account xpub of an existing seed wallet (default → primary Vault, else its
  // sealed seed), used to detect a duplicate import. Best-effort: null if unreadable.
  const seedAccountXpub = async (id: string): Promise<string | null> => {
    try {
      return exportAccountXpub(await openSeedMaster(id), NETWORK, 0)
    } catch {
      return null
    }
  }

  // Import a second seed wallet: validate the phrase, reject a duplicate (same account
  // xpub as an existing seed wallet), seal it under a fresh wallet dir, then register it.
  // Sealing needs the app-data key, so the wallet must be unlocked. Does not switch.
  const addSeedWallet = async (label: string, mnemonic: string, passphrase?: string): Promise<readonly WalletInfo[]> => {
    const phrase = mnemonic.trim().replace(/\s+/g, ' ')
    if (!validateMnemonic(phrase)) throw new Error('That recovery phrase is not valid.')
    const pass = passphrase !== undefined && passphrase !== '' ? passphrase : undefined
    const xpub = exportAccountXpub(masterKeyFromSeed(mnemonicToSeed(phrase, pass)), NETWORK, 0)
    for (const e of registry.list()) {
      if (e.kind === 'seed' && (await seedAccountXpub(e.id)) === xpub) throw new Error('This wallet is already imported.')
    }
    const id = randomUUID()
    const store = new SeedStore(new FileVaultStorage(join(walletDir(userData, id), 'seed.json')), vault)
    await store.save(pass !== undefined ? { mnemonic: phrase, passphrase: pass } : { mnemonic: phrase })
    const name = label.trim()
    registry.add({ id, kind: 'seed', label: name === '' ? 'Imported wallet' : name, createdAt: Date.now() })
    return listWallets()
  }

  // Preview a pasted private key: candidate algorithms + the address each would
  // watch. Persists nothing. Schnorr is offered only when the feature flag is on.
  const inspectKey = async (wif: string): Promise<KeyInspection> =>
    inspectWifKey(wif.trim(), NETWORK, { includeSchnorr: isSchnorrEnabled() })

  // Import a single private key (WIF) as a new key wallet: decode + pick the
  // algorithm, materialize once to validate (Falcon runs its pair self-check) and
  // fix the address, reject a duplicate, then seal it under a fresh wallet dir.
  // Sealing needs the app-data key, so the wallet must be unlocked. Does not switch.
  const addKeyWallet = async (label: string, wif: string, algoHint?: AddressAlgo): Promise<readonly WalletInfo[]> => {
    const cleanWif = wif.trim()
    const { payload, candidates } = decodeWif(cleanWif, NETWORK)
    payload.fill(0) // only the candidate list is needed here
    const algo = algoHint ?? candidates[0]
    if (algo === undefined || !candidates.includes(algo)) throw new Error('That key cannot be used with the chosen algorithm.')
    if (algo === 'schnorr' && !isSchnorrEnabled()) throw new Error('Schnorr keys are not enabled yet.')

    const key = await importedKeyFromStored({ wif: cleanWif, algo, address: '' }, NETWORK)
    key.privateKey.fill(0) // the session re-materializes on demand
    for (const info of await listWallets()) {
      if (info.address === key.address) throw new Error('This key is already covered by one of your wallets.')
    }

    const id = randomUUID()
    const store = new KeyStore(new FileVaultStorage(join(walletDir(userData, id), 'key.json')), vault)
    await store.save({ wif: cleanWif, algo, address: key.address })
    const name = label.trim()
    registry.add({ id, kind: 'key', label: name === '' ? 'Imported key' : name, createdAt: Date.now() })
    return listWallets()
  }

  // ── Ephemeral sweep (send from a pasted private key) ─────────────────────────
  // The key is materialized on scan, held here only until confirm/cancel/lock, and
  // never written to disk or the registry. Independent of the active wallet.
  let sweep: SweepSession | null = null
  const disposeSweep = (): void => {
    sweep?.dispose()
    sweep = null
  }
  const sweepScan = async (wif: string, algoHint?: AddressAlgo): Promise<{ address: string; balanceAtomic: string }> => {
    disposeSweep()
    const cleanWif = wif.trim()
    const { payload, candidates } = decodeWif(cleanWif, NETWORK)
    payload.fill(0)
    const algo = algoHint ?? candidates[0]
    if (algo === undefined || !candidates.includes(algo)) throw new Error('That key cannot be used with the chosen algorithm.')
    if (algo === 'schnorr' && !isSchnorrEnabled()) throw new Error('Schnorr keys are not enabled yet.')
    const key = await importedKeyFromStored({ wif: cleanWif, algo, address: '' }, NETWORK)
    // Snapshot the current chain client so a mid-wizard node change can't repoint it.
    sweep = createSweepSession(chainClient, key, NETWORK)
    const { balanceAtomic } = await sweep.scanBalance()
    return { address: key.address, balanceAtomic }
  }
  const sweepBuild = (recipient: string, amountAtomic: bigint | undefined, sendMax: boolean): Promise<SendPreview> => {
    if (sweep === null) throw new Error('No key loaded to sweep. Start again.')
    return sweep.send.buildSend(recipient, amountAtomic ?? 0n, undefined, sendMax)
  }
  const sweepConfirm = async (): Promise<SendResult> => {
    if (sweep === null) throw new Error('No sweep to confirm. Start again.')
    const result = await sweep.send.confirmSend()
    disposeSweep()
    return result
  }

  // Forgot-password recovery: re-create the primary wallet from a recovery phrase with a
  // new password. The phrase is validated BEFORE wiping anything, so an invalid phrase
  // can't strand the wallet. With the same seed this is non-destructive — the app-data
  // key is seed-derived, so every wallet's sealed data still opens; a different phrase
  // effectively starts a fresh primary wallet.
  const restoreFromMnemonic = async (mnemonic: string, password: string): Promise<VaultStatus> => {
    const phrase = mnemonic.trim().replace(/\s+/g, ' ')
    if (!validateMnemonic(phrase)) throw new Error('That recovery phrase is not valid.')
    await vault.destroy()
    await vault.create(phrase, password)
    registry.setActive(DEFAULT_WALLET_ID)
    rebuildActive()
    return vault.getStatus()
  }

  const renameWallet = async (id: string, label: string): Promise<readonly WalletInfo[]> => {
    const name = label.trim()
    registry.rename(id, name === '' ? 'Wallet' : name)
    return listWallets()
  }

  // Remove a wallet (watch or imported seed) and delete its on-disk data. The primary
  // 'default' wallet can't be removed — its seed roots the app-data key that seals every
  // wallet's data. Reassigns/rebuilds the active session if the removed wallet was active.
  const removeWallet = async (id: string): Promise<readonly WalletInfo[]> => {
    const entry = registry.get(id)
    if (entry === undefined) throw new Error(`Unknown wallet '${id}'`)
    if (id === DEFAULT_WALLET_ID) throw new Error('The primary wallet cannot be removed.')
    const wasActive = id === registry.getActiveId()
    registry.remove(id)
    if (wasActive) rebuildActive()
    await rm(walletDir(userData, id), { recursive: true, force: true })
    return listWallets()
  }

  // Build the active seed wallet's watch descriptor (per scheme: account xpub + its
  // Falcon address list; active scheme first, per the registry order) for sharing
  // with a watch-only install. Requires the wallet unlocked; only a seed wallet has
  // keys to derive from. Master and meta both belong to the ACTIVE wallet — an
  // imported seed wallet exports ITS OWN descriptor, not the primary's.
  const exportWatchDescriptor = async (): Promise<string> => {
    const id = registry.getActiveId()
    const entry = registry.get(id)
    if (entry?.kind !== 'seed') throw new Error('Only a seed wallet can export a watch descriptor.')
    const master = await openSeedMaster(id)
    const meta = await new WalletMetaStore(new FileVaultStorage(join(walletDir(userData, id), 'walletmeta.json')), vault).load()
    const descriptor = await buildSeedWatchDescriptor({ master, meta, network: NETWORK, label: entry.label })
    return encodeWatchDescriptor(descriptor)
  }

  // ── Node selection (Network card) ────────────────────────────────────────────
  // Current settings for the renderer: active slot, the bundled public nodes (which
  // one leads), the own-node URL if set, the added nodes, and the Tor flag.
  const nodeSettings = (): NodeSettings => {
    const s = nodeConfig.getSettings()
    const out: {
      selected: NodeKind
      publicNodes: NodeSettings['publicNodes']
      selectedPublicUrl?: string
      ownUrl?: string
      customNodes: NodeSettings['customNodes']
      selectedCustomUrl?: string
      tor: boolean
      hasAuth: boolean
      authUser?: string
      network: typeof NETWORK
    } = {
      selected: s.selected,
      publicNodes: publicEndpoints.map((e) => ({ url: e.url, name: e.name, operator: e.operator })),
      customNodes: s.customNodes.map((c) => (c.name !== undefined ? { url: c.url, name: c.name } : { url: c.url })),
      tor: s.tor,
      hasAuth: ownAuth !== null,
      network: NETWORK,
    }
    // Resolved rather than passed through, so the UI never has to repeat the
    // "absent means the first one" rule (and an install whose pick was dropped
    // in an update sees the node it is actually talking to).
    const primaryPublic = primaryPublicUrl(s, publicEndpoints)
    if (primaryPublic !== undefined) out.selectedPublicUrl = primaryPublic
    if (s.selectedCustomUrl !== undefined) out.selectedCustomUrl = s.selectedCustomUrl
    if (s.ownUrl !== undefined) out.ownUrl = s.ownUrl
    if (ownAuth?.user !== undefined && ownAuth.user !== '') out.authUser = ownAuth.user
    return out
  }

  // Rebuild the chain client from the persisted settings (+ auth) and re-point the session.
  const applyNode = (): void => {
    chainClient = buildChainClient()
    rebuildActive()
  }

  // Activate a slot. 'electrum' isn't wired yet; 'own' needs a URL set first;
  // 'custom' needs the URL of a node from the stored list.
  const selectNode = async (kind: NodeKind, url?: string): Promise<NodeSettings> => {
    if (kind === 'electrum') throw new Error('The Electrum backend is not available yet.')
    if (kind === 'own' && nodeConfig.getSettings().ownUrl === undefined) throw new Error('Set your node URL first.')
    nodeConfig.setSelected(kind as StoredNodeKind, url)
    applyNode()
    return nodeSettings()
  }

  // Add (or rename) a user-provided PUBLIC esplora node. Probed first, exactly
  // like the own node — a URL that is down or serves the wrong chain must not
  // enter the failover pool. No credentials here by design: auth belongs to
  // the own-node slot; a community endpoint everyone shares has no secrets.
  const addCustomNode = async (rawUrl: string, name?: string): Promise<NodeSettings> => {
    const url = normalizeNodeUrl(rawUrl)
    if (nodeConfig.getSettings().ownUrl === url) {
      throw new Error('That URL is already configured as your own node.')
    }
    const probe: NodeEndpoint = { name: 'Probe', url, protocol: 'esplora', network: NETWORK, operator: 'User-added', priority: 1 }
    const status = await new ChainClient({ network: NETWORK, endpoints: [probe] }).getNodeStatus()
    const expectedChain = NETWORK === 'mainnet' ? 'main' : 'testnet'
    if (status.chain !== expectedChain) throw new Error(`That node serves ${status.chain ?? 'an unknown chain'}, but this wallet runs on ${NETWORK}.`)
    nodeConfig.addCustomNode(url, name)
    applyNode()
    return nodeSettings()
  }

  // Remove a custom node (the store falls back to 'public' if it was active).
  const removeCustomNode = async (url: string): Promise<NodeSettings> => {
    nodeConfig.removeCustomNode(url)
    applyNode()
    return nodeSettings()
  }

  // Set the own-node URL with optional Basic-auth credentials. A non-empty password sets
  // (replaces) the credential; an empty password KEEPS the existing one (the password is
  // never shown in the form, so a blank field means "unchanged" — editing the URL won't
  // wipe saved auth). Probe FIRST (with the effective auth) so a bad URL or wrong password
  // can't strand the wallet, confirm the network, then persist (password sealed) and rebuild.
  const setOwnNode = async (rawUrl: string, user?: string, password?: string): Promise<NodeSettings> => {
    const url = normalizeNodeUrl(rawUrl)
    const replacing = password !== undefined && password !== ''
    const auth: NodeAuth | null = replacing ? (user !== undefined && user !== '' ? { user, password } : { password }) : ownAuth
    const authHeader = auth !== null ? basicAuthHeader(auth) : undefined
    const status = await new ChainClient({ network: NETWORK, endpoints: endpointsFor({ selected: 'own', ownUrl: url, tor: false, customNodes: [] }), transport: authHeader !== undefined ? { authHeader } : undefined }).getNodeStatus()
    // The node reports "main" / "testnet" / "regtest"; hold it against the
    // network THIS build runs on, not a hardcoded mainnet.
    const expectedChain = NETWORK === 'mainnet' ? 'main' : 'testnet'
    if (status.chain !== expectedChain) throw new Error(`That node serves ${status.chain ?? 'an unknown chain'}, but this wallet runs on ${NETWORK}.`)
    if (replacing) {
      await nodeAuthStore.save(auth as NodeAuth)
      ownAuth = auth
    }
    nodeConfig.setOwnUrl(url)
    nodeConfig.setSelected('own')
    applyNode()
    return nodeSettings()
  }

  // Drop the own-node URL (and any stored credential) and fall back to the public node.
  const clearOwnNode = async (): Promise<NodeSettings> => {
    nodeConfig.clearOwnUrl()
    await nodeAuthStore.clear()
    ownAuth = null
    applyNode()
    return nodeSettings()
  }

  // Persist the Tor flag. Routing is not wired yet (#89) — the flag is remembered for
  // when it is, and the active client is unchanged.
  const setTor = (enabled: boolean): NodeSettings => {
    nodeConfig.setTor(enabled)
    return nodeSettings()
  }

  // Live status of the active endpoint for the connection indicator: height, syncing
  // and the round-trip latency. Never throws — an unreachable node is reported as such.
  const nodeStatus = async (): Promise<NodeStatus> => {
    const url = chainClient.endpoints[0]?.url ?? ''
    const t0 = Date.now()
    try {
      const s = await chainClient.getNodeStatus()
      return {
        url,
        reachable: true,
        chain: s.chain,
        blockHeight: s.blocks,
        syncing: s.initialBlockDownload,
        latencyMs: Date.now() - t0,
        ...(s.btcSynced !== undefined ? { btcSynced: s.btcSynced } : {}),
        ...(s.btcHeaders !== undefined ? { btcHeaders: s.btcHeaders } : {}),
        ...(s.btcScanned !== undefined ? { btcScanned: s.btcScanned } : {}),
      }
    } catch {
      return { url, reachable: false }
    }
  }

  // Switch the network profile. A switch IS a restart: the whole session
  // (chain client, address derivation, storage roots) is built for exactly
  // one network at startup, so we persist the choice and relaunch. The
  // relaunched process reads the new profile and uses its scoped data root;
  // the other network's wallets stay on disk, hidden until switched back.
  const setNetwork = async (next: Network): Promise<void> => {
    if (next === NETWORK) return
    writeNetworkProfile(userDataBase, next)
    app.relaunch()
    app.quit()
  }

  // Held drafts and cached metadata must not survive a lock — confirming across a lock
  // would sign something reviewed in a different session.
  vault.on((event) => {
    if (event.type === 'unlocked') {
      unlocked = true
      // Load any sealed own-node credential now the app-data key is available; if the
      // own node is active, rebuild the client with auth before warming, else just warm.
      void nodeAuthStore
        .load()
        .then((auth) => {
          ownAuth = auth
          if (auth !== null && nodeConfig.getSettings().selected === 'own') applyNode()
          else active.prewarm()
        })
        .catch(() => active.prewarm())
    } else if (event.type === 'locked' || event.type === 'destroyed') {
      unlocked = false
      ownAuth = null
      nodeAuthStore.reset()
      active.reset()
      contacts.reset()
      // An in-flight sweep holds a plaintext key in memory — wipe it on lock too.
      disposeSweep()
    }
  })

  // Upgrade ops helpers: the flow exists only when the brand configures it AND
  // the active wallet can derive (seed). Amount strings are parsed here so the
  // service sees bigint; bigints are stringified on the way out.
  const requireUpgrade = (): UpgradeService => {
    if (active.upgrade === null) throw new Error('BTC upgrade is not available for this wallet.')
    return active.upgrade
  }
  const requireDowngrade = (): DowngradeService => {
    if (active.downgrade === null) throw new Error('The BTC downgrade is not available for this wallet.')
    return active.downgrade
  }
  const parseAtomic = (s: string): bigint => {
    if (!/^\d+$/.test(s)) throw new Error('Enter a valid atomic amount.')
    return BigInt(s)
  }
  const parseSat = (s: string): bigint => {
    if (!/^\d+$/.test(s)) throw new Error('Enter a valid satoshi amount.')
    return BigInt(s)
  }
  const parseConvertRequest = (req: UpgradeConvertRequest): ConvertRequest =>
    req.mode === 'all' ? { mode: 'all' } : { mode: 'amount', amountSat: parseSat(req.amountSat) }
  const planView = (p: ConvertPlan): UpgradePlanView => ({
    sendValueSat: p.sendValue.toString(),
    feeSat: p.fee.toString(),
    changeValueSat: p.changeValue.toString(),
    feeRate: p.feeRate,
    foldedChange: p.foldedChange,
  })

  // The orchestrator is built once; its read/write ops delegate to whichever session
  // is active, so a wallet switch needs no IPC re-wiring.
  const orchestrator = new VaultOrchestrator({
    vault,
    mnemonic: { generateMnemonic: () => generateMnemonic(12), validateMnemonic },
    addresses: {
      getReceiveAddress: (algo) => active.addresses.getReceiveAddress(algo),
      getNewReceiveAddress: (algo) => active.addresses.getNewReceiveAddress(algo),
      listReceiveAddresses: (algo) => active.addresses.listReceiveAddresses(algo),
    },
    chain: {
      getSummary: () => active.chain.getSummary(),
      getHistory: (pages) => active.chain.getHistory(pages),
      estimateFee: () => active.chain.estimateFee(),
      listTokens: () => active.chain.listTokens(),
      setTxLabel: (txid, label) => active.chain.setTxLabel(txid, label),
      getTxDetail: (txid) => active.chain.getTxDetail(txid),
      getTxRaw: (txid) => active.chain.getTxRaw(txid),
      getSnapshot: () => active.chain.getSnapshot(),
    },
    send: {
      buildSend: (recipient, amountAtomic, outpoints, sendMax) => active.send.buildSend(recipient, amountAtomic, outpoints, sendMax),
      maxSendable: (outpoints) => active.send.maxSendable(outpoints),
      buildTokenSend: (tokenId, recipient, tokenAmount) => active.send.buildTokenSend(tokenId, recipient, tokenAmount),
      confirmSend: () => active.send.confirmSend(),
    },
    coins: {
      list: () => active.coins.list(),
      setLabel: (outpoint, label) => active.coins.setLabel(outpoint, label),
      setFrozen: (outpoint, frozen) => active.coins.setFrozen(outpoint, frozen),
    },
    contacts,
    wallets: { list: listWallets, add: addWatchWallet, addSeed: addSeedWallet, inspectKey, addKey: addKeyWallet, restore: restoreFromMnemonic, switch: switchWallet, rename: renameWallet, remove: removeWallet, exportDescriptor: exportWatchDescriptor },
    sweep: { scan: sweepScan, build: sweepBuild, confirm: sweepConfirm, cancel: disposeSweep },
    node: { get: nodeSettings, select: selectNode, setOwn: setOwnNode, clearOwn: clearOwnNode, addCustom: addCustomNode, removeCustom: removeCustomNode, setTor, status: nodeStatus, setNetwork },
    upgrade: {
      info: async () => ({
        enabled: active.upgrade !== null,
        ...(active.upgrade !== null && UPGRADE !== null ? { minConvertValueSat: UPGRADE[NETWORK].minConvertValue.toString() } : {}),
      }),
      status: async () => {
        const s = await requireUpgrade().status()
        return {
          stagingAddress: s.stagingAddress,
          stagingIndex: s.stagingIndex,
          confirmedBalanceSat: s.confirmedBalance.toString(),
          pendingBalanceSat: s.pendingBalance.toString(),
          episodes: s.episodes.map((e) => ({
            txid: e.txid,
            lockValueSat: e.lockValue.toString(),
            destScripthashHex: e.destScripthashHex,
            confirmed: e.confirmed,
            ...(e.blockHeight !== undefined ? { blockHeight: e.blockHeight } : {}),
            ...(e.confirmations !== undefined ? { confirmations: e.confirmations } : {}),
          })),
        }
      },
      plan: async (req) => planView(await requireUpgrade().planConvert(parseConvertRequest(req))),
      convert: async (req, destAddress) => {
        // The credit goes to a NATIVE address of this chain — decode it here so
        // the service stays chain-agnostic (it only sees the scripthash).
        if (!validateAddress(destAddress, NETWORK)) {
          throw new Error('Enter a valid address of this chain to receive the credit.')
        }
        const { scripthash } = decodeAddress(destAddress)
        const { txid } = await requireUpgrade().convert(parseConvertRequest(req), scripthash)
        return { txid }
      },
      returnBtc: async (destBtcAddress) => {
        const res = await requireUpgrade().returnAll(destBtcAddress)
        return { txid: res.txid, valueSat: res.value.toString(), feeSat: res.fee.toString() }
      },
    },
    downgrade: {
      info: async () => ({ enabled: active.downgrade !== null }),
      status: async () => {
        const views = await requireDowngrade().status()
        return views.map((v) => ({
          freezeTxid: v.freezeTxid,
          vout: v.vout,
          valueAtomic: v.valueAtomic,
          state: v.state,
          ...(v.btcAddress !== undefined ? { btcAddress: v.btcAddress } : {}),
          ...(v.reclaimableAt !== undefined ? { reclaimableAt: v.reclaimableAt } : {}),
          ...(v.downgradeTxid !== undefined ? { downgradeTxid: v.downgradeTxid } : {}),
          ...(v.burnTxid !== undefined ? { burnTxid: v.burnTxid } : {}),
          ...(v.btcTxid !== undefined ? { btcTxid: v.btcTxid } : {}),
        }))
      },
      plan: async (amountAtomic) => requireDowngrade().plan(parseAtomic(amountAtomic)),
      convert: async (amountAtomic, btcAddress) => requireDowngrade().convert(parseAtomic(amountAtomic), btcAddress),
      reclaim: async (freezeTxid) => requireDowngrade().reclaim(freezeTxid),
    },
  })

  return { vault, orchestrator }
}

// A watch wallet has no keys: every send/sign path refuses.
function watchOnlySend(): SendOps {
  const refuse = (): Promise<never> => Promise.reject(new Error('This is a watch-only wallet — it has no keys and cannot sign or send.'))
  return { buildSend: refuse, maxSendable: refuse, buildTokenSend: refuse, confirmSend: refuse }
}

// Receive addresses for a watch wallet, read from its key-free source. A watch wallet
// can be funded but can't advance derivation indices like a seed wallet, so "new"
// returns the first receive address. With a multi-scheme source, branches come
// active-scheme-first, so `find` lands on the primary (receivable) branch.
function watchReceiveOps(source: AddressSource): AddressOps {
  const receive = async (algo: AddressAlgo): Promise<string[]> => {
    const branch = (await source.branches()).find((b) => b.algo === algo)
    if (branch === undefined) return []
    if (branch.kind === 'list') return branch.addresses.filter((a) => a.chain === 0).map((a) => a.address)
    const out: string[] = []
    for (let i = 0; i < 5; i += 1) out.push(await Promise.resolve(branch.derive(0, i)))
    return out
  }
  const first = async (algo: AddressAlgo): Promise<string> => {
    const [addr] = await receive(algo)
    if (addr === undefined) throw new Error('This wallet has no receive address for that address type.')
    return addr
  }
  return {
    getReceiveAddress: (algo = 'ecdsa') => first(algo),
    getNewReceiveAddress: (algo = 'ecdsa') => first(algo),
    listReceiveAddresses: async (algo = 'ecdsa') => (await receive(algo)).map((address, index) => ({ address, index, current: index === 0 })),
  }
}
