import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { PRODUCTION_CSP } from './src/shared/csp'

// Bake the production CSP into the built index.html as a <meta> tag — the form
// Electron documents for file://-loaded pages, where response headers don't
// reliably apply. Build-only: the dev server + HMR need a looser policy, and
// dev keeps its real boundary (sandbox + contextIsolation) regardless.
function injectCspMeta(): Plugin {
  return {
    name: 'inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: PRODUCTION_CSP },
            injectTo: 'head-prepend',
          },
        ],
      }
    },
  }
}

// Three independent builds: main (Node) and preload (CommonJS, required for a
// sandboxed preload) are kept lean via externalizeDepsPlugin; the renderer is a
// normal Vite + React app. The Vault and crypto will live in `main` in Phase 1.
export default defineConfig({
  main: {
    // Bundle the @qbtc/* packages into main rather than externalizing them:
    // they are pure ESM (the main bundle is CJS), bundling keeps a single copy
    // of @qbtc/crypto shared by the vault and our own code (so its error
    // classes match across the boundary), and the Falcon WASM glue they import
    // dynamically lands in the bundle (see wallet/falconWasm.ts for how the
    // .wasm itself is located). Real npm deps stay external.
    plugins: [externalizeDepsPlugin({ exclude: ['@qbtc/crypto', '@qbtc/chain', '@qbtc/vault'] })],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
      assetsInlineLimit: 0,
    },
    plugins: [react(), injectCspMeta()],
  },
})
