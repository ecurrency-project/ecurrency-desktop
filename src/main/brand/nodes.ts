import { nodesFor, type Network, type NodeEndpoint } from '@qbtc/chain'

// The public node endpoints this build ships. @qbtc/chain carries no URLs of
// its own — which nodes a wallet talks to is a deployment decision, so the
// list lives here and is handed to the chain client at startup.
//
// BRAND FILE: the endpoint list is a brand value — each brand branch fills in
// its own public nodes. The common base ships none (the network may not be
// launched yet); the wallet then requires a self-hosted node in Settings.
export const DEFAULT_NODES: readonly NodeEndpoint[] = [
  // Brand branches append their public Esplora / JSON-RPC nodes here.
]

/** The bundled endpoints serving `network`, sorted by priority. */
export function defaultNodesFor(network: Network): NodeEndpoint[] {
  return nodesFor(DEFAULT_NODES, network)
}
