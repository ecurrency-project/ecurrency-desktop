import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Three independent builds: main (Node) and preload (CommonJS, required for a
// sandboxed preload) are kept lean via externalizeDepsPlugin; the renderer is a
// normal Vite + React app. The Vault and crypto will live in `main` in Phase 1.
export default defineConfig({
  main: {
    // Bundle the workspace @qbitcoin/* packages into main (they ship TypeScript
    // source, which Node can't require if externalized). Real npm deps stay external.
    plugins: [externalizeDepsPlugin({ exclude: ['@qbitcoin/crypto', '@qbitcoin/vault', '@qbitcoin/chain'] })],
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
    },
    plugins: [react()],
  },
})
