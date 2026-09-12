import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setFalcon512WasmSource } from '@qbtc/crypto'

// The Falcon-512 WASM ships inside @qbtc/crypto/wasm. Because main BUNDLES the
// crypto package (see electron.vite.config), the package's own relative loader
// (`new URL('../wasm/…', import.meta.url)`) can't find the .wasm at runtime — the
// bundle isn't at the package's path. So we resolve the package on disk (its
// entry is dist/index.js; the WASM sits next to dist/ in wasm/) and hand the raw
// bytes to the loader, which then never needs to locate the file itself. Call
// once at startup, before any sign/verify/keygen.
export function configureFalconWasm(): void {
  setFalcon512WasmSource(async () => {
    const require = createRequire(__filename)
    const cryptoMain = require.resolve('@qbtc/crypto')
    const wasmPath = join(dirname(cryptoMain), '..', 'wasm', 'falcon512.wasm')
    return new Uint8Array(await readFile(wasmPath))
  })
}
