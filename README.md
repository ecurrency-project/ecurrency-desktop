# qecurrency Wallet — Desktop

A non-custodial desktop wallet for the eCurrency (ECR) network, built with
Electron. Keys are generated and stored locally and never leave the machine.
Supports post-quantum (Falcon-512) signatures alongside classical secp256k1.
Runs on macOS, Windows, and Linux from one codebase.

> Early development. The app builds and runs; not all flows are implemented yet.

## Architecture in one line

The decrypted seed lives only in the Electron **main** process; the **renderer**
(UI) is key-free and talks to main over a typed IPC bridge (`window.wallet`).
`contextIsolation` and `sandbox` are on; `nodeIntegration` is off.

## Prerequisites

- **Node 22** — `nvm use` reads [`.nvmrc`](./.nvmrc). On Windows use nvm-windows or the Node 22 installer.
- **pnpm 10** — enable via Corepack: `corepack enable`.
- **Git**.
- To build platform installers: build each OS's installer on that OS (or a matching CI runner) — see "Package installers".

## Get the code

The crypto, chain and vault layers come from npm as `@qbtc/crypto`,
`@qbtc/chain` and `@qbtc/vault` (exact pins). There is no submodule or
workspace to set up. Just clone:

```bash
git clone <repo-url>
cd <repo>
```

## Install

```bash
corepack enable      # makes the pinned pnpm available
pnpm install         # installs the @qbtc/* packages and everything else
```

## Develop

```bash
pnpm dev             # launches Electron with the renderer on Vite HMR
```

## Verify

```bash
pnpm typecheck       # tsc for the node (main/preload) and web (renderer) projects
pnpm lint            # eslint
pnpm test            # vitest (unit)
pnpm test:e2e        # Playwright drives the built app: onboarding → lock → unlock
```

`test:e2e` builds the app first, then launches it through Playwright's Electron
support; each test runs against a throwaway user-data profile. Run it on a
desktop OS with a display (macOS/Windows), not a headless CI container.

## Build & run the compiled app

```bash
pnpm build           # electron-vite build → ./out
pnpm start           # run the compiled app (electron-vite preview)
```

## Package installers

`electron-builder` produces installers into `./release`:

```bash
pnpm dist            # current OS
pnpm dist:mac        # macOS  → .dmg + .zip
pnpm dist:win        # Windows → NSIS installer (.exe)
pnpm dist:linux      # Linux  → AppImage
```

Notes:

- **Build each platform on that platform** (or a matching CI runner): macOS on
  macOS, Windows on Windows. Cross-building a Windows installer from macOS/Linux
  is technically possible with electron-builder, but native (or CI) builds are
  more reliable and are required once signing is added.
- **No native modules.** The dependencies are pure JavaScript/WASM, so there are
  no per-platform native rebuilds — which makes cross-platform packaging simpler
  than a typical Electron app.
- **Unsigned by default.** Installers run with an OS warning (macOS Gatekeeper /
  Windows SmartScreen). Code signing — macOS Developer ID + notarization, Windows
  EV certificate or Azure Trusted Signing — is configured in a later step.
- **Icons** (optional): drop `icon.icns` (mac), `icon.ico` (win), and/or
  `icon.png` (linux) into [`resources/`](./resources) for branded installers;
  electron-builder picks them up automatically.

### Windows specifics

On a Windows machine (PowerShell), the steps are identical:

```powershell
corepack enable
pnpm install
pnpm dist:win        # → release\qecurrency Wallet-<version>-setup.exe
```

If you only need to run/test (not produce an installer), `pnpm build` then
`pnpm start` works on Windows too.

## Continuous integration

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs typecheck, lint, and
unit tests on every push and pull request. The shared packages come from the
public npm registry, so no submodule fetch or extra credentials are needed. Per-platform
release builds (a macOS + Windows matrix) are added with the signing step.

## Project layout

```
src/
  main/        Electron main — window, IPC router; owns the Vault
    vault/     unlock-lifecycle orchestrator (pure, unit-tested)
    ipc/
  preload/     contextBridge — exposes the narrow, typed window.wallet API
  renderer/    React UI (key-free)
    ui/        reusable UI kit (Button, fields, layout, …)
    screens/   onboarding, unlock, wallet
  shared/      the typed IPC protocol shared by main + preload
tests/unit/    vitest (pure logic)
tests/e2e/     Playwright (drives the built Electron app)
resources/     build resources (installer icons)
```

## Troubleshooting

- **Peer-dependency warnings on install** → keep the Vite toolchain aligned: the
  `vite`, `@vitejs/plugin-react`, and `vitest` majors should match (this repo
  targets the Vite 7 line with electron-vite 5).
- **"cannot build Windows target on this OS" / wine errors** → build the Windows
  installer on Windows (or a `windows-latest` CI runner).

## License

[Apache-2.0](./LICENSE).
