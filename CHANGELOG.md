# Changelog

## 1.7.0 — 2026-10-04

### Added

- Read release notes inside the wallet, even offline or before unlocking, from What’s new in the sidebar or Help menu.

## 1.6.1 — 2026-10-01

### Fixed

- Transaction history and details now load for wallets receiving staking rewards. Staking rewards are shown separately from transaction fees.

## 1.6.0 — 2026-09-29

Safer backups, more control over sensitive information, and a smoother wallet setup.

### Check your imported wallets

**Save a separate backup for each imported wallet.** Settings → Wallet backup
now shows the backup for the wallet you have selected. Earlier versions always
showed the Main wallet's recovery phrase. That phrase does not restore your
imported wallets: select each one and save its own recovery phrase or private key.

### Backup and privacy

- **The right backup for every wallet.** Imported seed wallets show their own
  recovery phrase and exact BIP39 passphrase; imported keys show their private
  key, signature algorithm, address and network. Watch-only wallets export
  public data for following the same wallet on another device.
- **Secrets appear only when you ask.** Recovery phrases and private keys hide
  after two minutes, when you switch windows, or when you choose Hide now.
  Revealing a backup from Settings always asks for your password.
- **Screen capture protection.** On Windows, the wallet window is excluded from
  screenshots and recordings while a secret is visible. On macOS and Linux,
  a reminder asks you to pause screen sharing and recording first.
- **Fewer clipboard copies.** Recovery phrases and displayed private keys cannot
  be copied or dragged out of the wallet. A pasted private key is cleared from
  the clipboard after import.
- **Automatic locking.** Sleep, screen lock, switching users and closing the
  window lock the wallet. If the window stops responding, it is hidden and
  locked; after a crash, the wallet reopens locked.
- **Password protection.** After three incorrect passwords, further attempts
  have a growing delay of up to 30 seconds. Unlocking, revealing backups and
  changing the password share this limit.
- **Safer password recovery.** Restoring from a recovery phrase replaces the
  existing wallet only after its replacement is complete, then asks you to
  unlock with your new password.

### Improvements

- **A calmer backup check.** Confirming a recovery phrase has no countdown,
  preserves the words you enter while you consult your notes, and checks each
  word after you leave its field.
- **Clearer forms.** Field hints and errors work with screen readers; keyboard
  focus stays visible in Windows High Contrast mode. Long phrases and keys
  expand their fields, and validation waits until you leave a field.
- **Cleaner release menus.** Developer tools, page reload and the macOS
  Services menu are removed from release builds.

### Fixes

- Tall dialogs fit inside the window and scroll, keeping their actions reachable.
- The Max button in Send from a key is aligned with the amount field.
- Coin and transaction labels are saved correctly when using an input method editor.
- An imported wallet's BIP39 passphrase is preserved even when it contains only spaces.

### Existing wallets

Wallets, passwords, contacts and settings carry over without a data migration.
