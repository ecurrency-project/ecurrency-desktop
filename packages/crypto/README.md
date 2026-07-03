# @qbitcoin/crypto

Cryptographic primitives for the the chain wallet. Pure TypeScript, zero
browser dependencies — runs in Node, in Vitest, and in the extension's
background service worker.

This package is the **only** place in the codebase where signing keys exist as
plaintext bytes. Everything else (`@qbitcoin/chain`, `@qbitcoin/vault`,
`@qbitcoin/ui`, the extension itself) treats keys as opaque handles managed
here.

## Layout

```
src/
├─ encoding/
│  ├─ varint.ts          Bitcoin variable-length integers
│  ├─ varstr.ts          length-prefixed byte strings
│  ├─ base58check.ts     Base58Check (version + 4-byte checksum)
│  └─ hex.ts             hex ↔ bytes helpers
├─ hashes.ts             sha256, ripemd160, hash160, hash256, checksum32
├─ script.ts             P2PK redeem-script construction
├─ address.ts            encode / decode / validate addresses
├─ bip39.ts              mnemonic ↔ seed
├─ bip32.ts              HD derivation (secp256k1)
├─ secp256k1.ts          ECDSA sign / verify
├─ falcon512.ts          Falcon-512 (post-quantum) via a WASM module
├─ transaction.ts        tx model, serialization + sighash
├─ signing.ts            per-input signing (algorithm dispatch)
├─ signedMessage.ts      canonical signed-message format
├─ vault.ts              seed sealing — Argon2id KDF + AES-256-GCM
├─ appData.ts            HKDF data-encryption key + AES-GCM (e.g. address book)
└─ index.ts              public API
```

## Principles

- **Test vectors first.** Each primitive is written against known
  inputs/outputs from a canonical source (BIP specs, Bitcoin test vectors, the
  node's own test suite) before it's implemented.
- **No browser globals.** Must run in Node; the extension imports it like any
  normal library.
- **No runtime CDN / remote code.** Only published, lockfile-pinned npm
  dependencies.

## Dependencies

| Package | Why |
|--|--|
| `@noble/hashes` | SHA-256, RIPEMD-160, Argon2id — audited, zero-dep, constant-time |
| `@noble/curves` | secp256k1 ECDSA |
| `@scure/base` | Base58Check encoding |
| `@scure/bip39` | Mnemonic phrases |
| `@scure/bip32` | HD derivation |

Falcon-512 is provided by a WebAssembly module compiled from
[PQClean](https://github.com/PQClean/PQClean) (built by `tools/falcon512-wasm`,
vendored at `wasm/falcon512.{wasm,mjs}`).

## Tests

```bash
pnpm --filter @qbitcoin/crypto test
pnpm --filter @qbitcoin/crypto test:watch
pnpm --filter @qbitcoin/crypto typecheck
```
