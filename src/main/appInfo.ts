// BRAND FILE: display identity for the MAIN process (menus, dialogs).
// Brand branches edit the values in place.
//
// Deliberately NOT wired to app.getName()/package.json `productName`:
// Electron derives the default userData path from app.name, and shipped
// brands must keep that path byte-stable (installed wallets would
// "disappear" otherwise). These constants are presentation only.

/** Human-readable product name for menu items and dialogs. */
export const PRODUCT_NAME = 'QBitcoin Wallet'

/** Brand website for Help → Learn More; null hides the item. */
export const HOMEPAGE: string | null = null
