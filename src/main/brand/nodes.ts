import { nodesFor, type Network, type NodeEndpoint } from '@qbtc/chain'

// The public node endpoints this build ships. @qbtc/chain carries no URLs of
// its own — which nodes a wallet talks to is a deployment decision, so the
// list lives here and is handed to the chain client at startup.
//
// BRAND FILE: the endpoint list is a brand value — each brand branch fills in
// its own public nodes. eCurrency ships the project's public Esplora node on
// mainnet; there is no public testnet node (testing runs against production
// nodes), so a testnet profile needs a self-hosted node in Settings.
export const DEFAULT_NODES: readonly NodeEndpoint[] = [
  {
    name: 'eCurrency.org',
    url: 'https://api.ecurrency.org',
    protocol: 'esplora',
    network: 'mainnet',
    operator: 'eCurrency Project',
    priority: 1,
  },
  // Future community-run Esplora / JSON-RPC nodes append here.
]

/** The bundled endpoints serving `network`, sorted by priority. */
export function defaultNodesFor(network: Network): NodeEndpoint[] {
  return nodesFor(DEFAULT_NODES, network)
}
