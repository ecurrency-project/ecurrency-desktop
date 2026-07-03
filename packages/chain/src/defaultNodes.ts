// Default node endpoints the wallet talks to.
//
// The chain client owns its own configuration: the extension imports from
// @qbitcoin/chain and never sees raw URLs.
//
// BRAND FILE: the endpoint list is a brand value — each brand branch fills
// in its own public nodes. The common base ships none (the network may not
// be launched yet); the wallet then requires a self-hosted node in Settings.

export type Protocol = 'esplora' | 'jsonrpc';
export type Network = 'mainnet' | 'testnet';

export interface NodeEndpoint {
  /** Human-readable label shown in Settings → Networks. */
  readonly name: string;
  /** Base URL — HTTPS only. No trailing slash. */
  readonly url: string;
  /** Which protocol the endpoint speaks. */
  readonly protocol: Protocol;
  /** Network this endpoint serves. */
  readonly network: Network;
  /** Operator name shown next to the entry in UI. */
  readonly operator: string;
  /**
   * Priority — lower wins. The wallet picks the smallest-priority reachable
   * endpoint for the active network. Failover moves to the next priority on
   * 5xx or timeout.
   */
  readonly priority: number;
}

export const DEFAULT_NODES: readonly NodeEndpoint[] = [
  // Brand branches append their public Esplora / JSON-RPC nodes here.
];

/** Subset of DEFAULT_NODES for a given network, sorted by priority. */
export function nodesFor(network: Network): NodeEndpoint[] {
  return DEFAULT_NODES.filter((n) => n.network === network).sort(
    (a, b) => a.priority - b.priority,
  );
}
