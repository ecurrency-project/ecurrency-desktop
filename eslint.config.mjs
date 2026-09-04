import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  // The reused @qbitcoin/* packages are linted in their own repo.
  { ignores: ['out/**', 'dist/**', 'release/**', 'packages/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // A leading underscore marks an intentionally-unused binding (a positional
    // argument, a destructured value, or a caught error we don't inspect).
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'electron.vite.config.ts', 'vitest.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Build-time hooks run in Node before the app is packaged, and stay
    // CommonJS because electron-builder requires them at build time.
    files: ['build/**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
)
