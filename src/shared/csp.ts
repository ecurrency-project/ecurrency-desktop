// The production Content-Security-Policy — single source of truth.
//
// Applied twice, deliberately:
//  • as a response header from the main process (src/main/index.ts) — covers
//    anything served over http(s);
//  • as a <meta http-equiv> tag injected into the built index.html
//    (electron.vite.config.ts) — the form Electron documents as required for
//    pages loaded via file://, which is how the packaged renderer loads.
//
// Dev builds get neither (the Vite dev server + HMR need a looser policy);
// the primary boundary there, as in prod, is sandbox + contextIsolation.
//
// 'unsafe-inline' for styles: React inline style attributes; scripts stay
// strictly 'self'. connect-src 'self': the renderer performs no network I/O —
// every chain/node request goes through main over IPC.
export const PRODUCTION_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'"
