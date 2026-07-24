import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Network } from '@qbitcoin/crypto'

// The network PROFILE: which chain this installation runs on. A plain
// (unsealed) file in the REAL userData root — it must be readable before
// any unlock, and it decides where everything else lives.
//
// Storage layout (docs/network-profiles-plan.md):
//   mainnet — files stay EXACTLY where they always were, flat under
//             userData (shipped wallets must not move: the userData trap);
//   testnet — an isolated subtree under userData/testnet/.
// The profile file itself always lives in the unscoped root. Pure module:
// paths come in as arguments so the logic is unit-testable without Electron.

const PROFILE_FILE = 'network.json'

/** Parse a profile file's contents. Anything but an explicit testnet → mainnet. */
export function parseNetworkProfile(raw: string | null): Network {
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { network?: unknown }
      if (parsed.network === 'testnet') return 'testnet'
    } catch {
      // Malformed profile — fall through to the pre-profile default.
    }
  }
  return 'mainnet'
}

/** Read the profile from `baseDir` (the real userData root). Missing/broken → mainnet. */
export function readNetworkProfile(baseDir: string): Network {
  let raw: string | null
  try {
    raw = readFileSync(join(baseDir, PROFILE_FILE), 'utf8')
  } catch {
    raw = null
  }
  return parseNetworkProfile(raw)
}

export function writeNetworkProfile(baseDir: string, network: Network): void {
  writeFileSync(join(baseDir, PROFILE_FILE), `${JSON.stringify({ network })}\n`)
}

/**
 * Network-scoped data root. Mainnet returns `baseDir` unchanged — byte-exact
 * historical paths. Testnet gets (and creates) an isolated subdirectory.
 */
export function dataRootFor(baseDir: string, network: Network): string {
  if (network === 'mainnet') return baseDir
  const root = join(baseDir, network)
  mkdirSync(root, { recursive: true })
  return root
}
