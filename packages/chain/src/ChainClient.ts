// ChainClient — the public surface for the wallet's chain access.
//
// Wraps one or more EsploraClient instances for a given network and
// implements failover: if the primary endpoint returns http_5xx, network
// or timeout, the next-priority node is tried before propagating the
// error up.
//
// For broadcast we do NOT failover automatically. A successful broadcast
// to node A means the tx is in the p2p network — re-broadcasting through
// node B is at best wasteful and at worst causes confusing UX (which
// node "owns" the broadcast?). Caller can manually retry.

import type { NodeEndpoint } from './defaultNodes';
import { nodesFor, type Network } from './defaultNodes';
import { ChainError, isRetryableCode } from './errors';
import { EsploraClient } from './EsploraClient';
import type {
  AddressInfo,
  BlockchainInfo,
  BroadcastResult,
  ChainTx,
  FeeEstimates,
  NodeStatus,
  TokenInfo,
  TokenTransfer,
  Utxo,
} from './types';
import type { TransportOptions } from './transport';

export interface ChainClientConfig {
  readonly network: Network;
  /** Override the default node list (handy for tests + custom RPC). */
  readonly endpoints?: readonly NodeEndpoint[];
  readonly transport?: TransportOptions;
}

export class ChainClient {
  private readonly clients: readonly EsploraClient[];
  readonly network: Network;

  constructor(config: ChainClientConfig) {
    this.network = config.network;
    const endpoints =
      config.endpoints !== undefined && config.endpoints.length > 0
        ? config.endpoints
        : nodesFor(config.network);
    if (endpoints.length === 0) {
      throw new Error(`No endpoints configured for network '${config.network}'`);
    }
    this.clients = endpoints.map(
      (e) => new EsploraClient(e, config.transport),
    );
  }

  /** Currently active (primary) endpoint. Visible for diagnostics. */
  get endpoints(): readonly NodeEndpoint[] {
    return this.clients.map((c) => c.endpoint);
  }

  // ─── Read methods — each tries clients in order ────────────────────

  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.tryEachRead((c) => c.getBlockchainInfo());
  }

  getNodeStatus(): Promise<NodeStatus> {
    return this.tryEachRead((c) => c.getNodeStatus());
  }

  getAddressInfo(address: string): Promise<AddressInfo> {
    return this.tryEachRead((c) => c.getAddressInfo(address));
  }

  listUnspent(address: string): Promise<Utxo[]> {
    return this.tryEachRead((c) => c.listUnspent(address));
  }

  getTransaction(txid: string): Promise<ChainTx> {
    return this.tryEachRead((c) => c.getTransaction(txid));
  }

  getTransactionHex(txid: string): Promise<string> {
    return this.tryEachRead((c) => c.getTransactionHex(txid));
  }

  getAddressTransactions(address: string, afterTxid?: string): Promise<ChainTx[]> {
    return this.tryEachRead((c) =>
      c.getAddressTransactions(address, afterTxid),
    );
  }

  getAddressTransfers(address: string, tokenId: string, afterTxid?: string): Promise<TokenTransfer[]> {
    return this.tryEachRead((c) => c.getAddressTransfers(address, tokenId, afterTxid));
  }

  getFeeEstimates(): Promise<FeeEstimates> {
    return this.tryEachRead((c) => c.getFeeEstimates());
  }

  getTokenInfo(id: string): Promise<TokenInfo> {
    return this.tryEachRead((c) => c.getTokenInfo(id));
  }

  // ─── Broadcast — single attempt, no failover ───────────────────────

  /**
   * Send `rawHex` to the primary node. Does NOT fall back to other
   * nodes on failure — see file header for rationale.
   *
   * Returns the txid as confirmed by the node + which endpoint took it.
   */
  async broadcastTransaction(rawHex: string): Promise<BroadcastResult> {
    const primary = this.clients[0];
    if (primary === undefined) {
      throw new Error('ChainClient has no endpoints configured');
    }
    const txid = await primary.broadcastTransaction(rawHex);
    return { txid, endpoint: primary.endpoint };
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /**
   * Try each EsploraClient in order. On a retryable failure (5xx,
   * network, timeout) advance to the next; on any non-retryable
   * failure propagate immediately (because 4xx means the request is
   * malformed, not the node).
   */
  private async tryEachRead<T>(
    op: (c: EsploraClient) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (const client of this.clients) {
      try {
        return await op(client);
      } catch (e) {
        lastError = e;
        if (e instanceof ChainError && !isRetryableCode(e.code)) {
          throw e;
        }
        // Otherwise, try the next endpoint.
      }
    }
    // We exhausted all endpoints. Re-throw the last error so the
    // caller sees the most-recent (and most-informative) reason.
    throw lastError;
  }
}
