import { defineConfig } from '@playwright/test'

// End-to-end tests drive the built Electron app (out/main/index.js) through
// Playwright's Electron support. They run serially because a desktop app is a
// single shared instance, and each test launches its own throwaway profile.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
})
