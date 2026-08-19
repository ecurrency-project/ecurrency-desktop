// A minimal Bitcoin-family script disassembler for the advanced transaction view.
// It turns a script's hex into readable ASM — push operations become
// `OP_PUSHBYTES_<n> <data>` and known opcodes get their names. It's display-only
// (never used for validation), so on any malformed input it falls back gracefully
// to the remaining raw bytes rather than throwing.

// The opcodes our scripts actually use, plus the common ones, named for readability.
const OPCODES: Record<number, string> = {
  0x00: 'OP_0',
  0x4c: 'OP_PUSHDATA1',
  0x4d: 'OP_PUSHDATA2',
  0x4e: 'OP_PUSHDATA4',
  0x4f: 'OP_1NEGATE',
  0x51: 'OP_1',
  0x56: 'OP_6',
  0x57: 'OP_7',
  0x61: 'OP_NOP',
  0x63: 'OP_IF',
  0x67: 'OP_ELSE',
  0x68: 'OP_ENDIF',
  0x6a: 'OP_RETURN',
  0x75: 'OP_DROP',
  0x76: 'OP_DUP',
  0x78: 'OP_OVER',
  // The chain's introspection opcodes (covenants: freeze/downgrade/delegation).
  0x7e: 'OP_TX_TYPE',
  0x7f: 'OP_SUBSTR',
  0x80: 'OP_OUTPUTDATA',
  0x87: 'OP_EQUAL',
  0x88: 'OP_EQUALVERIFY',
  0xa9: 'OP_HASH160',
  0xaa: 'OP_HASH256',
  0xac: 'OP_CHECKSIG',
  0xad: 'OP_CHECKSIGVERIFY',
  0xae: 'OP_CHECKMULTISIG',
  0xaf: 'OP_CHECKMULTISIGVERIFY',
  0xb1: 'OP_CHECKLOCKTIMEVERIFY',
  0xb2: 'OP_CHECKSEQUENCEVERIFY',
}

function hexToBytes(hex: string): number[] {
  const clean = hex.trim().toLowerCase()
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) return []
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 2) out.push(Number.parseInt(clean.slice(i, i + 2), 16))
  return out
}

// Disassemble a script hex into space-separated ASM tokens. Returns an empty string
// for empty input; on a truncated push, emits what was decoded plus the leftover hex.
export function disassembleScript(hex: string): string {
  const bytes = hexToBytes(hex)
  if (bytes.length === 0) return hex.trim()
  const tokens: string[] = []
  let i = 0
  const readData = (len: number): string => {
    const slice = bytes.slice(i, i + len)
    i += len
    return slice.map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  while (i < bytes.length) {
    const op = bytes[i]!
    i += 1
    if (op >= 0x01 && op <= 0x4b) {
      tokens.push(`OP_PUSHBYTES_${String(op)}`, readData(op))
    } else if (op === 0x4c || op === 0x4d || op === 0x4e) {
      const n = op === 0x4c ? 1 : op === 0x4d ? 2 : 4
      let len = 0
      for (let k = 0; k < n; k++) len |= (bytes[i + k] ?? 0) << (8 * k)
      i += n
      tokens.push(OPCODES[op]!, readData(len))
    } else if (op >= 0x51 && op <= 0x60) {
      tokens.push(`OP_${String(op - 0x50)}`)
    } else {
      tokens.push(OPCODES[op] ?? `OP_UNKNOWN(0x${op.toString(16).padStart(2, '0')})`)
    }
  }
  return tokens.join(' ')
}
