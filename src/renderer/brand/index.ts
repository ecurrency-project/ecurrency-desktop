// Brand configuration for this build. Every user-visible brand value in the
// renderer must come from this module — screens and components never hardcode
// coin names, tickers, explorer URLs, or brand artwork. Mirrors the node's
// admin brand module: the common branch carries a neutral stub here and
// each brand branch overrides the values (and Logo.tsx) in its own stack.
//
// Deliberately JSX-free: non-UI code (lib/format.ts) and node-side test
// programs import this config, so the artwork lives in ./Logo (imported
// directly by UI code) instead of being re-exported here.

export interface BrandConfig {
  /** Ticker shown next to amounts, e.g. "QBT". */
  assetLabel: string
  /** Human-readable coin/network name, e.g. "QBitcoin". */
  assetName: string
  /** Product name shown in the titlebar and onboarding, e.g. "QBitcoin Wallet". */
  productName: string
  /** Onboarding subtitle line. */
  tagline: string
  /** Block-explorer transaction URL prefix (txid appended), or null when the
   *  chain has no public explorer yet — the UI hides explorer links then. */
  explorerTxUrl: string | null
  /** Placeholder text for address inputs. */
  addressPlaceholder: string
  /** Default REST port of a self-hosted node, used in Settings hints. */
  nodeRestPort: number
  /** Source-chain upgrade flow (e.g. BTC→native conversion), or null when
   *  this brand has none — the Convert screen and nav entry stay hidden.
   *  Consensus values live in the crypto package (UPGRADE); this is only
   *  the renderer-facing presentation. */
  upgrade: {
    /** Ticker of the source chain being converted from, e.g. "BTC". */
    sourceCoinLabel: string
    /** Explorer tx URL prefix of the SOURCE chain, or null. */
    sourceExplorerTxUrl: string | null
  } | null
}

// Neutral stub — brand branches override these values in their own stack.
export const brand: BrandConfig = {
  assetLabel: 'COIN',
  assetName: 'Blockchain',
  productName: 'Wallet',
  tagline: "A quantum-safe home for your coins. Let's set up your wallet.",
  explorerTxUrl: null,
  addressPlaceholder: 'address…',
  nodeRestPort: 9557,
  upgrade: null,
}
