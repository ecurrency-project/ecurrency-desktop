import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeApi } from '../shared/bridge'
import { PRIVACY_CHANNEL, PRIVACY_EVENT_CHANNEL, type PrivacyApi, type PrivacyRequest, type SessionRevoked } from '../shared/privacy'
import {
  WALLET_CHANNEL,
  WALLET_EVENT_CHANNEL,
  UPDATE_EVENT_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  type FeeBands,
  type UpdateEvent,
  type UpdaterApi,
  type HistoryPage,
  type Contact,
  type KeyInspection,
  type MaxSendable,
  type NodeSettings,
  type NodeStatus,
  type PingResult,
  type ReceiveAddressEntry,
  type SendPreview,
  type SendResult,
  type SweepScan,
  type TokenBalance,
  type TokenSendPreview,
  type TxDetail,
  type UtxoView,
  type WalletSnapshot,
  type UpgradeConvertResult,
  type UpgradeInfo,
  type UpgradePlanView,
  type UpgradeReturnResult,
  DowngradeEpisodeIpcView,
  DowngradeInfoView,
  DowngradePlanView,
  type UpgradeStatusView,
  type VaultRequest,
  type VaultStatus,
  type WalletApi,
  type WalletInfo,
  type WalletRequest,
  type WalletResponse,
  type WalletSummary,
  type WatchInput,
} from '../shared/protocol'

// The only code with both Electron access and a line to the renderer. It exposes
// a narrow, typed API — never ipcRenderer itself — across contextIsolation.
async function request<T>(req: WalletRequest | VaultRequest): Promise<WalletResponse<T>> {
  return ipcRenderer.invoke(WALLET_CHANNEL, req) as Promise<WalletResponse<T>>
}

const api: BridgeApi<WalletApi> = {
  ping: () => request<PingResult>({ type: 'ping' }),
  getStatus: () => request<VaultStatus>({ type: 'vault.getStatus' }),
  create: (mnemonic, password) => request<VaultStatus>({ type: 'vault.create', mnemonic, password }),
  unlock: (password) => request<VaultStatus>({ type: 'vault.unlock', password }),
  lock: () => request<VaultStatus>({ type: 'vault.lock' }),
  destroy: () => request<VaultStatus>({ type: 'vault.destroy' }),
  revealMnemonic: (password, sessionId) => request<string>({ type: 'vault.revealMnemonic', password, sessionId }),
  changePassword: (oldPassword, newPassword) => request<void>({ type: 'vault.changePassword', oldPassword, newPassword }),
  noteActivity: () => request<void>({ type: 'vault.noteActivity' }),
  generateMnemonic: (sessionId) => request<string>({ type: 'vault.generateMnemonic', sessionId }),
  validateMnemonic: (phrase) => request<boolean>({ type: 'vault.validateMnemonic', phrase }),
  getReceiveAddress: (algo) => request<string>({ type: 'wallet.getReceiveAddress', algo }),
  getNewReceiveAddress: (algo) => request<string>({ type: 'wallet.getNewReceiveAddress', algo }),
  listReceiveAddresses: (algo) => request<readonly ReceiveAddressEntry[]>({ type: 'wallet.listReceiveAddresses', algo }),
  getSummary: () => request<WalletSummary>({ type: 'chain.getSummary' }),
  getHistory: (pages) => request<HistoryPage>({ type: 'chain.getHistory', pages }),
  setTxLabel: (txid, label) => request<void>({ type: 'chain.setTxLabel', txid, label }),
  getTxDetail: (txid) => request<TxDetail>({ type: 'chain.getTxDetail', txid }),
  getTxRaw: (txid) => request<string>({ type: 'chain.getTxRaw', txid }),
  getSnapshot: () => request<WalletSnapshot | null>({ type: 'chain.getSnapshot' }),
  listTokens: () => request<TokenBalance[]>({ type: 'chain.listTokens' }),
  estimateFee: () => request<FeeBands>({ type: 'chain.estimateFee' }),
  buildSend: (recipient, amountAtomic, outpoints, sendMax) => request<SendPreview>({ type: 'wallet.buildSend', recipient, amountAtomic, outpoints, sendMax }),
  maxSendable: (outpoints) => request<MaxSendable>({ type: 'wallet.maxSendable', outpoints }),
  buildTokenSend: (tokenId, recipient, tokenAmountAtomic) => request<TokenSendPreview>({ type: 'wallet.buildTokenSend', tokenId, recipient, tokenAmountAtomic }),
  confirmSend: () => request<SendResult>({ type: 'wallet.confirmSend' }),
  listCoins: () => request<UtxoView[]>({ type: 'coins.list' }),
  setUtxoLabel: (outpoint, label) => request<void>({ type: 'coins.setLabel', outpoint, label }),
  setUtxoFrozen: (outpoint, frozen) => request<void>({ type: 'coins.setFrozen', outpoint, frozen }),
  listContacts: () => request<readonly Contact[]>({ type: 'contacts.list' }),
  addContact: (name, address) => request<readonly Contact[]>({ type: 'contacts.add', name, address }),
  removeContact: (address) => request<readonly Contact[]>({ type: 'contacts.remove', address }),
  listWallets: () => request<readonly WalletInfo[]>({ type: 'wallets.list' }),
  addWatchWallet: (label, input: WatchInput) => request<readonly WalletInfo[]>({ type: 'wallets.add', label, input }),
  addSeedWallet: (label, mnemonic, passphrase) => request<readonly WalletInfo[]>({ type: 'wallets.addSeed', label, mnemonic, passphrase }),
  inspectKey: (wif) => request<KeyInspection>({ type: 'wallets.inspectKey', wif }),
  addKeyWallet: (label, wif, algo) => request<readonly WalletInfo[]>({ type: 'wallets.addKey', label, wif, algo }),
  sweepScan: (wif, sessionId, algo) => request<SweepScan>({ type: 'sweep.scan', wif, sessionId, algo }),
  sweepBuild: (recipient, amountAtomic, sendMax) => request<SendPreview>({ type: 'sweep.build', recipient, amountAtomic, sendMax }),
  sweepConfirm: () => request<SendResult>({ type: 'sweep.confirm' }),
  sweepCancel: (sessionId) => request<void>({ type: 'sweep.cancel', sessionId }),
  restoreWallet: (mnemonic, password) => request<VaultStatus>({ type: 'wallets.restore', mnemonic, password }),
  switchWallet: (id) => request<readonly WalletInfo[]>({ type: 'wallets.switch', id }),
  renameWallet: (id, label) => request<readonly WalletInfo[]>({ type: 'wallets.rename', id, label }),
  removeWallet: (id) => request<readonly WalletInfo[]>({ type: 'wallets.remove', id }),
  exportWatchDescriptor: () => request<string>({ type: 'wallets.exportDescriptor' }),
  getNode: () => request<NodeSettings>({ type: 'node.get' }),
  selectNode: (kind, url) => request<NodeSettings>({ type: 'node.select', kind, url }),
  setOwnNode: (url, user, password) => request<NodeSettings>({ type: 'node.setOwn', url, user, password }),
  clearOwnNode: () => request<NodeSettings>({ type: 'node.clearOwn' }),
  addCustomNode: (url, name) => request<NodeSettings>({ type: 'node.addCustom', url, name }),
  removeCustomNode: (url) => request<NodeSettings>({ type: 'node.removeCustom', url }),
  setTor: (enabled) => request<NodeSettings>({ type: 'node.setTor', enabled }),
  nodeStatus: () => request<NodeStatus>({ type: 'node.status' }),
  setNetwork: (network) => request<void>({ type: 'network.set', network }),
  upgradeInfo: () => request<UpgradeInfo>({ type: 'upgrade.info' }),
  upgradeStatus: () => request<UpgradeStatusView>({ type: 'upgrade.status' }),
  upgradePlan: (req) => request<UpgradePlanView>({ type: 'upgrade.plan', req }),
  upgradeConvert: (req, destAddress) => request<UpgradeConvertResult>({ type: 'upgrade.convert', req, destAddress }),
  upgradeReturn: (destBtcAddress) => request<UpgradeReturnResult>({ type: 'upgrade.return', destBtcAddress }),
  downgradeInfo: () => request<DowngradeInfoView>({ type: 'downgrade.info' }),
  downgradeStatus: () => request<readonly DowngradeEpisodeIpcView[]>({ type: 'downgrade.status' }),
  downgradePlan: (amountAtomic) => request<DowngradePlanView>({ type: 'downgrade.plan', amountAtomic }),
  downgradeConvert: (amountAtomic, btcAddress) => request<{ txid: string }>({ type: 'downgrade.convert', amountAtomic, btcAddress }),
  downgradeReclaim: (freezeTxid) => request<{ txid: string }>({ type: 'downgrade.reclaim', freezeTxid }),
  onStatusChanged: (listener) => {
    const handler = (_event: unknown, status: VaultStatus): void => listener(status)
    ipcRenderer.on(WALLET_EVENT_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(WALLET_EVENT_CHANNEL, handler)
    }
  },
}

// Separate, minimal surface for auto-update: subscribe to lifecycle events and
// request install. No updater internals reach the renderer.
const updater: UpdaterApi = {
  onEvent: (listener) => {
    const handler = (_event: unknown, e: UpdateEvent): void => listener(e)
    ipcRenderer.on(UPDATE_EVENT_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(UPDATE_EVENT_CHANNEL, handler)
    }
  },
  restartToInstall: () => ipcRenderer.send(UPDATE_INSTALL_CHANNEL),
}

contextBridge.exposeInMainWorld('wallet', api)
contextBridge.exposeInMainWorld('updater', updater)

async function privacyRequest<T>(req: PrivacyRequest): Promise<WalletResponse<T>> {
  return ipcRenderer.invoke(PRIVACY_CHANNEL, req) as Promise<WalletResponse<T>>
}
const privacy: BridgeApi<PrivacyApi> = {
  getCaptureStatus: () => privacyRequest({ type: 'status' }),
  begin: (purpose, acknowledged) => privacyRequest({ type: 'begin', purpose, acknowledged }),
  end: (sessionId) => privacyRequest({ type: 'end', sessionId }),
  cleared: () => privacyRequest({ type: 'cleared' }),
  onRevoked: (listener) => {
    const handler = (_event: unknown, event: SessionRevoked): void => listener(event)
    ipcRenderer.on(PRIVACY_EVENT_CHANNEL, handler)
    return () => { ipcRenderer.removeListener(PRIVACY_EVENT_CHANNEL, handler) }
  },
}
contextBridge.exposeInMainWorld('privacy', privacy)
