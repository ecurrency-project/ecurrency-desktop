import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setFalcon512WasmSource } from '@qbitcoin/crypto'

// The Falcon-512 WASM ships inside @qbitcoin/crypto/wasm. Because main BUNDLES
// the crypto package's TypeScript source (see electron.vite.config), the package's
// own relative loader (`new URL('../wasm/…', import.meta.url)`) can't find the
// .wasm at runtime — the bundle isn't at the package's path. So we resolve the
// package on disk and hand the raw bytes to the loader, which then never needs to
// locate the file itself. Call once at startup, before any sign/verify/keygen.
export function configureFalconWasm(): void {
  setFalcon512WasmSource(async () => {
    const require = createRequire(__filename)
    const cryptoMain = require.resolve('@qbitcoin/crypto')
    const wasmPath = join(dirname(cryptoMain), '..', 'wasm', 'falcon512.wasm')
    return new Uint8Array(await readFile(wasmPath))
  })
}
