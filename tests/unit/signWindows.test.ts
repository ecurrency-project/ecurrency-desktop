import { describe, expect, it } from 'vitest'
import {
  buildSignArgs,
  quoteForCmd,
  readSigningEnv,
  redact,
  type SigningCredentials,
} from '../../build/sign-windows.cjs'

// The Windows signing hook stands between the build and a remote HSM, so the
// failures worth guarding are: shipping unsigned because a variable was quietly
// missing, mangling a path that contains a space, and echoing a secret into a
// build log.

const credentials: SigningCredentials = {
  username: 'builds@example.org',
  password: 'p+a$s.w[o]rd',
  totpSecret: 'c2VjcmV0LXZhbHVl',
  credentialId: null,
  tool: 'CodeSignTool.sh',
}

describe('readSigningEnv', () => {
  it('names every missing variable rather than signing nothing', () => {
    expect(() => readSigningEnv({})).toThrow(/ES_USERNAME, ES_PASSWORD, ES_TOTP_SECRET/)
  })

  it('names only the variable that is actually missing', () => {
    const partial = { ES_USERNAME: 'builds@example.org', ES_TOTP_SECRET: 'c2VjcmV0' }
    expect(() => readSigningEnv(partial)).toThrow(/ES_PASSWORD not set/)
  })

  it('accepts an account with a single certificate, where credential_id is optional', () => {
    const resolved = readSigningEnv({
      ES_USERNAME: 'builds@example.org',
      ES_PASSWORD: 'pw',
      ES_TOTP_SECRET: 'c2VjcmV0',
    })
    expect(resolved.credentialId).toBeNull()
  })

  it('defaults the tool per platform and lets the environment override it', () => {
    const env = { ES_USERNAME: 'u', ES_PASSWORD: 'p', ES_TOTP_SECRET: 's' }
    expect(readSigningEnv(env, 'win32').tool).toBe('CodeSignTool.bat')
    expect(readSigningEnv(env, 'darwin').tool).toBe('CodeSignTool.sh')
    expect(readSigningEnv({ ...env, CODESIGNTOOL: 'C:\\tools\\CodeSignTool.bat' }, 'win32').tool).toBe(
      'C:\\tools\\CodeSignTool.bat',
    )
  })
})

describe('buildSignArgs', () => {
  it('omits credential_id when the account has one certificate', () => {
    const args = buildSignArgs(credentials, '/in/app.exe', '/out')
    expect(args.some((arg) => arg.startsWith('-credential_id='))).toBe(false)
  })

  it('passes credential_id when the account has several', () => {
    const args = buildSignArgs({ ...credentials, credentialId: 'abc123' }, '/in/app.exe', '/out')
    expect(args).toContain('-credential_id=abc123')
  })

  it('keeps a path containing spaces in a single argument', () => {
    const target = '/release/win-unpacked/Some Wallet.exe'
    const args = buildSignArgs(credentials, target, '/out dir')
    expect(args).toContain(`-input_file_path=${target}`)
    expect(args).toContain('-output_dir_path=/out dir')
  })
})

describe('redact', () => {
  it('removes the password and the TOTP secret from anything logged', () => {
    const echoed = `sign -password=${credentials.password} -totp_secret=${credentials.totpSecret}`
    const safe = redact(echoed, credentials)
    expect(safe).not.toContain(credentials.password)
    expect(safe).not.toContain(credentials.totpSecret)
    expect(safe).toBe('sign -password=*** -totp_secret=***')
  })

  it('survives a null message', () => {
    expect(redact(null, credentials)).toBe('')
  })
})

describe('quoteForCmd', () => {
  it('quotes an argument so cmd.exe does not split it on the space', () => {
    expect(quoteForCmd('-input_file_path=C:\\r\\Some Wallet.exe')).toBe(
      '"-input_file_path=C:\\r\\Some Wallet.exe"',
    )
  })

  it('refuses characters cmd.exe would reinterpret, without echoing the value', () => {
    for (const hostile of ['-password=pa"ss', '-password=pa%USERNAME%ss', '-password=pa^ss']) {
      expect(() => quoteForCmd(hostile)).toThrow(/cmd\.exe/)
      try {
        quoteForCmd(hostile)
      } catch (err) {
        expect((err as Error).message).not.toContain(hostile)
      }
    }
  })
})
