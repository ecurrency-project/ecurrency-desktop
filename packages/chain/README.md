# @qbitcoin/chain

Esplora-compatible REST client for the the chain wallet. Talks to one or more
nodes (brand-configured defaults), normalizes responses into typed domain
objects, and broadcasts signed transactions.

Pure TypeScript — no React, no DOM, no `chrome.storage`. It runs equally well in
a background service worker, a popup, or a Node test process; only `fetch` is
required.

## Why a separate package

- **Failover and retry policy in one place.** Every call site (status pings,
  send flow, history pages, the dApp provider) gets the same backoff, node
  failover and error mapping.
- **Stable domain types across backends.** Consumers import `AddressInfo`,
  `Utxo`, `ChainTx` and never see the raw Esplora JSON shape.
- **One audit surface.** Every byte the wallet sends to a remote node flows
  through this package.

## Public API

```ts
import { ChainClient } from '@qbitcoin/chain';

const client = new ChainClient({ network: 'mainnet' });

// Read
const info  = await client.getAddressInfo('EC…');
const utxos = await client.listUnspent('EC…');
const tx    = await client.getTransaction('<txid>');
const fees  = await client.getFeeEstimates();
const tip   = await client.getBlockchainInfo();

// Write
const { txid, endpoint } = await client.broadcastTransaction(signedHex);
```

All methods throw `ChainError` on failure; branch on `error.code`:

| Code | Meaning | Retry sensible? |
|--|--|--|
| `timeout` | Request didn't return within `timeoutMs` | yes |
| `network` | `fetch` rejected (DNS, TLS, abort) | yes |
| `http_5xx` | Server reachable, returned 500–599 | yes |
| `http_4xx` | Server reachable, returned 400–499 | no — request is wrong |
| `malformed_response` | 2xx but body unparseable | no — node is broken |
| `broadcast_rejected` | Tx rejected (bad sig, conflict, dust) | no |
| `invalid_argument` | Caller passed something obviously wrong | no |
| `unknown` | Should not happen — file a bug | no |

`isRetryableCode(code)` is the exported canonical check.

## Failover

`ChainClient` keeps an ordered endpoint list (lowest `priority` first). Read
methods advance to the next endpoint on a retryable failure. `broadcastTransaction`
tries only the primary node — re-broadcasting an already-propagated tx through a
second node doesn't help and complicates UX.

## Configuration

```ts
new ChainClient({
  network: 'mainnet',
  // Optional: override the default node list (e.g. a custom RPC URL).
  endpoints: [{ name: 'My node', url: 'https://my.node', priority: 0, network: 'mainnet' }],
  // Optional: tune the transport.
  transport: { timeoutMs: 15_000, maxRetries: 2, backoffMs: 250 },
});
```

## Tests

Unit tests run against JSON fixtures in `src/fixtures/` (written to the
documented Esplora shape). Refresh them against a real node before a release
with `tools/record-chain-fixtures.sh`; if that surfaces failures, fix the parser
rather than the fixtures.

```bash
pnpm --filter @qbitcoin/chain test
```

## Limitations

- **Esplora-only.** No JSON-RPC backend yet.
- **No caching.** Every call hits the network.
- **No push.** Polling only; no WebSocket subscriptions.
