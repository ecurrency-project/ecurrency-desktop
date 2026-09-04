// Types for the Windows signing hook. The hook itself is CommonJS because
// electron-builder requires it at build time; these declarations exist so the
// unit tests can import it.

export interface SigningCredentials {
  username: string
  password: string
  totpSecret: string
  /** Only set when the SSL.com account holds more than one certificate. */
  credentialId: string | null
  tool: string
}

export declare function readSigningEnv(
  env: Record<string, string | undefined>,
  platform?: string,
): SigningCredentials

export declare function buildSignArgs(
  credentials: SigningCredentials,
  inputPath: string,
  outputDir: string,
): string[]

export declare function redact(text: unknown, credentials: SigningCredentials): string

export declare function quoteForCmd(arg: string): string

/** The entry point electron-builder calls, once per file to sign. */
export declare function sign(configuration: { path: string }): Promise<void>
