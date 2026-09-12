import type { Network, NodeEndpoint } from '@qbtc/chain'
import type { NodeSettingsStored } from './nodeConfig'

// How the persisted node selection becomes the chain client's failover pool.
//
// Pure on purpose: this is the one place that decides WHICH backend the wallet
// talks to first and what it falls back to, so it is unit-tested directly
// instead of through the vault.
//
// Two rules:
//   - The own node stays ALONE when selected. It may carry credentials, and
//     the point of self-hosting is not leaking queries to anyone else — a
//     silent fallback to a public backend would defeat both.
//   - Every public backend is interchangeable (bundled or user-added), so they
//     mix into one pool: the selected one leads at priority 1 and the rest
//     follow as fallback. Bundled endpoints keep their brand order; user-added
//     ones sit behind them unless picked.

/** Display fallback for unnamed custom nodes ("https://x.y/api" → "x.y"). */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The primary bundled endpoint for a stored selection: the picked one, or the
 * first (highest-priority) when nothing is picked — including old configs
 * written before the pick existed. `undefined` when the build bundles none.
 */
export function primaryPublicUrl(
  settings: Pick<NodeSettingsStored, 'selectedPublicUrl'>,
  publicEndpoints: readonly NodeEndpoint[],
): string | undefined {
  const picked = publicEndpoints.find((e) => e.url === settings.selectedPublicUrl)
  return (picked ?? publicEndpoints[0])?.url
}

/** The failover pool for the active selection, in priority order. */
export function buildEndpoints(
  settings: NodeSettingsStored,
  publicEndpoints: readonly NodeEndpoint[],
  network: Network,
): NodeEndpoint[] {
  if (settings.selected === 'own' && settings.ownUrl !== undefined) {
    return [{ name: 'Your own node', url: settings.ownUrl, protocol: 'esplora', network, operator: 'Self-hosted', priority: 1 }]
  }
  const customEndpoints: NodeEndpoint[] = settings.customNodes.map((c, i) => ({
    name: c.name ?? hostOfUrl(c.url),
    url: c.url,
    protocol: 'esplora',
    network,
    operator: 'User-added',
    // Behind the bundled endpoints by default; the selected one is lifted below.
    priority: 100 + i,
  }))
  const pool = [...publicEndpoints, ...customEndpoints]
  // Which URL leads. 'public' with a single bundled node (the common case)
  // resolves to that node, so the ordering below is a no-op there.
  const leadUrl =
    settings.selected === 'custom'
      ? settings.selectedCustomUrl
      : primaryPublicUrl(settings, publicEndpoints)
  if (leadUrl === undefined) return pool
  const lead = pool.find((e) => e.url === leadUrl)
  if (lead === undefined) return pool
  return [{ ...lead, priority: 1 }, ...pool.filter((e) => e.url !== leadUrl)]
}
