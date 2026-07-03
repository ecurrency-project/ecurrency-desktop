import { defineConfig } from 'vitest/config'

// Unit tests run in Node (the orchestrator, IPC envelope, and other pure logic).
// Real Electron/e2e (Playwright) verification happens on macOS — see docs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
