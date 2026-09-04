// Windows Authenticode signing through SSL.com eSigner (cloud HSM).
//
// electron-builder's built-in signing path wants a .pfx file, and there is no
// longer one to give it: since June 2023 publicly trusted code signing keys are
// only issued on hardware, so ours lives in SSL.com's HSM and never leaves it.
// This hook replaces that path and shells out to SSL.com's CodeSignTool, which
// signs remotely.
//
// Credentials come from the environment at build time:
//   ES_USERNAME       SSL.com account email
//   ES_PASSWORD       SSL.com account password
//   ES_TOTP_SECRET    the secret behind the eSigner OTP QR code, base64
//   ES_CREDENTIAL_ID  optional — only needed when the account holds more than
//                     one code signing certificate
//   CODESIGNTOOL      optional path to the CodeSignTool executable
//
// Without them the build fails by design: an unsigned release must never leave
// quietly. Three files are signed per build — the app executable, the
// uninstaller and the installer.

const { spawnSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const REQUIRED = ['ES_USERNAME', 'ES_PASSWORD', 'ES_TOTP_SECRET']

function readSigningEnv(env, platform = process.platform) {
  const missing = REQUIRED.filter((name) => !env[name])
  if (missing.length > 0) {
    throw new Error(
      `Windows code signing is not configured: ${missing.join(', ')} not set in the environment.`,
    )
  }
  return {
    username: env.ES_USERNAME,
    password: env.ES_PASSWORD,
    totpSecret: env.ES_TOTP_SECRET,
    credentialId: env.ES_CREDENTIAL_ID || null,
    tool: env.CODESIGNTOOL || (platform === 'win32' ? 'CodeSignTool.bat' : 'CodeSignTool.sh'),
  }
}

function buildSignArgs(credentials, inputPath, outputDir) {
  const args = ['sign', `-username=${credentials.username}`, `-password=${credentials.password}`]
  if (credentials.credentialId) {
    args.push(`-credential_id=${credentials.credentialId}`)
  }
  args.push(
    `-totp_secret=${credentials.totpSecret}`,
    `-input_file_path=${inputPath}`,
    `-output_dir_path=${outputDir}`,
  )
  return args
}

// Anything CodeSignTool prints can quote the command line back at us, so every
// message that reaches a build log goes through here first.
function redact(text, credentials) {
  let out = String(text == null ? '' : text)
  for (const secret of [credentials.password, credentials.totpSecret]) {
    if (secret) {
      out = out.split(secret).join('***')
    }
  }
  return out
}

// Node refuses to spawn .bat/.cmd without a shell (the 2024 argument-injection
// fix), and cmd.exe then re-splits the command line — so the arguments have to
// come back quoted. Paths reaching this point contain spaces ('<app>.exe').
//
// Quoting is not enough for cmd's own metacharacters: a password containing one
// of these arrives at the tool truncated, which the signing service reports as
// a plain authentication failure — ten minutes into a build, with nothing
// pointing at the real cause. Refuse it up front instead.
function quoteForCmd(arg) {
  if (/["%^&|<>!]/.test(arg)) {
    throw new Error(
      'Cannot pass an argument containing " % ^ & | < > or ! through cmd.exe, which is how a ' +
        'batch entry point has to be launched. Choose an SSL.com password without those ' +
        'characters — @ # - . = + are safe.',
    )
  }
  return `"${arg}"`
}

// The tool locates its bundled runtime and its configuration relative to the
// working directory rather than to its own location, so it has to be started
// from where it lives: run from the project root it exits with nothing but
// 'The system cannot find the path specified'. For a bare name on PATH
// path.dirname gives '.', which leaves the working directory as it was.
function runCodeSignTool(tool, args, platform = process.platform) {
  const viaCmd = platform === 'win32' && /\.(bat|cmd)$/i.test(tool)
  const cwd = path.dirname(tool)
  return viaCmd
    ? spawnSync([tool, ...args].map(quoteForCmd).join(' '), { shell: true, encoding: 'utf8', cwd })
    : spawnSync(tool, args, { encoding: 'utf8', cwd })
}

async function sign(configuration) {
  const credentials = readSigningEnv(process.env)
  // Absolute, because the tool runs with its own directory as the working one.
  const target = path.resolve(configuration.path)
  const name = path.basename(target)

  // CodeSignTool writes <output_dir_path>/<basename>, which would collide with
  // its own input if we pointed it at the file's own directory. Sign into a
  // scratch directory and copy the result back over the original instead —
  // copy, not rename, because the two can sit on different volumes.
  //
  // Setting `resultOutputPath` would be the documented way to hand the signed
  // file back, but electron-builder passes this hook a *copy* of its task
  // configuration and reads the field off the original, so the assignment
  // never arrives.
  const outputDir = mkdtempSync(path.join(tmpdir(), 'codesign-'))
  try {
    console.log(`signing ${name} with SSL.com eSigner`)
    const result = runCodeSignTool(credentials.tool, buildSignArgs(credentials, target, outputDir))
    if (result.error) {
      throw new Error(
        `Could not run CodeSignTool ('${credentials.tool}'): ${redact(result.error.message, credentials)}. ` +
          'Set CODESIGNTOOL to its full path.',
      )
    }
    if (result.status !== 0) {
      throw new Error(
        `CodeSignTool failed for ${name} (exit ${result.status}):\n` +
          redact(result.stdout, credentials) +
          redact(result.stderr, credentials),
      )
    }
    const signed = path.join(outputDir, name)
    if (!existsSync(signed)) {
      throw new Error(
        `CodeSignTool reported success but wrote no signed file for ${name}:\n` +
          redact(result.stdout, credentials),
      )
    }
    copyFileSync(signed, target)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
}

module.exports = { sign, readSigningEnv, buildSignArgs, redact, quoteForCmd }
