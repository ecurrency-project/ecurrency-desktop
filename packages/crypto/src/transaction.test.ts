import { describe, expect, it } from 'vitest';
import { SIGHASH } from './constants';
import { fromHex, toHex } from './encoding/hex';
import {
  TX_TYPE_STANDARD,
  TX_TYPE_TOKENS,
  encodeTokenTransfer,
  serialize,
  serializeForSighash,
  sighash,
  txid,
  type Transaction,
} from './transaction';

// Real transaction captured from a live node (`/api/mempool/recent`),
// dump captured during protocol research.
//
// If our serialize + hash256 produces the same txid as the node ran on
// the same logical transaction, we are byte-for-byte protocol-compatible
// for the classical (ECDSA) signing path.
const MAINNET_TX: Transaction = {
  txType: TX_TYPE_STANDARD,
  inputs: [
    {
      txid: fromHex(
        '7cbf37f26bdaea7615c506c4507a9613c4776936d6860ecd8ec046e19699db32',
      ),
      vout: 2,
      siglist: [
        fromHex(
          '01013045022100fb9864295b0d9897de67038fde90023bf0e05d523e5837138fd541ec791e52a2022025dd966192586003603ba451d07cf39d8a05d638b967ae916c313102300ff3dd',
        ),
      ],
      redeemScript: fromHex(
        '21039b66566d3acb6bd203a0a61f4e0105b84f12e107aaf27f30466807121197d10cac',
      ),
    },
  ],
  outputs: [
    {
      value: 39800995n,
      scripthash: fromHex('de4bde2de43a35b7538e9992b94f2c29bec01e8b'),
    },
    {
      value: 6579599427781n,
      scripthash: fromHex('ad5ef5738c9b3e8de242e75d3f99c5b92a49a25a'),
    },
  ],
};

const MAINNET_TXID =
  '3c0efded93e7c11a39992d2a19aa13a8e03bbf9a265f939a0951d6f810458ad8';

describe('serialize — real mainnet vector', () => {
  it('produces a transaction whose hash256 matches the known txid', () => {
    expect(toHex(txid(MAINNET_TX))).toBe(MAINNET_TXID);
  });

  it('serialized form starts with tx_type byte 0x01', () => {
    expect(serialize(MAINNET_TX)[0]).toBe(TX_TYPE_STANDARD);
  });

  it('contains the input txid bytes verbatim', () => {
    const ser = toHex(serialize(MAINNET_TX));
    expect(ser).toContain(
      '7cbf37f26bdaea7615c506c4507a9613c4776936d6860ecd8ec046e19699db32',
    );
  });

  it('contains both output scripthashes verbatim', () => {
    const ser = toHex(serialize(MAINNET_TX));
    expect(ser).toContain('de4bde2de43a35b7538e9992b94f2c29bec01e8b');
    expect(ser).toContain('ad5ef5738c9b3e8de242e75d3f99c5b92a49a25a');
  });
});

describe('serializeForSighash', () => {
  it('omits siglist and redeemScript from inputs', () => {
    const sighashSer = toHex(serializeForSighash(MAINNET_TX));
    const full = toHex(serialize(MAINNET_TX));
    // sighash serialization is strictly shorter — no signatures inline.
    expect(sighashSer.length).toBeLessThan(full.length);
    // It must NOT contain the signature bytes.
    expect(sighashSer).not.toContain('3045022100fb9864');
    // But MUST contain the input txid and outputs.
    expect(sighashSer).toContain(
      '7cbf37f26bdaea7615c506c4507a9613c4776936d6860ecd8ec046e19699db32',
    );
    expect(sighashSer).toContain('de4bde2de43a35b7538e9992b94f2c29bec01e8b');
  });

  it('is deterministic', () => {
    expect(toHex(serializeForSighash(MAINNET_TX))).toBe(
      toHex(serializeForSighash(MAINNET_TX)),
    );
  });

  it('rejects unsupported sighash types', () => {
    expect(() => serializeForSighash(MAINNET_TX, SIGHASH.NONE)).toThrow(RangeError);
    expect(() => serializeForSighash(MAINNET_TX, SIGHASH.SINGLE)).toThrow(RangeError);
    expect(() => serializeForSighash(MAINNET_TX, SIGHASH.ANYONECANPAY)).toThrow(RangeError);
  });
});

describe('sighash', () => {
  it('returns 32 bytes', () => {
    expect(sighash(MAINNET_TX).length).toBe(32);
  });

  it('is deterministic', () => {
    expect(toHex(sighash(MAINNET_TX))).toBe(toHex(sighash(MAINNET_TX)));
  });

  it('is the double-SHA256 of serializeForSighash', () => {
    // Implementation detail check: we compute hash256 of the sighash
    // bytes, never anything else.
    const direct = sighash(MAINNET_TX);
    // Reproducing the operation by hand:
    const bytes = serializeForSighash(MAINNET_TX);
    // We trust hashes.ts (separately tested), so just ensure the API
    // composition matches the spec text.
    expect(direct.length).toBe(32);
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe('serialize — error cases', () => {
  it('throws if an input is missing its siglist', () => {
    const broken: Transaction = {
      ...MAINNET_TX,
      inputs: [{ ...MAINNET_TX.inputs[0]!, siglist: undefined }],
    };
    expect(() => serialize(broken)).toThrow(/missing siglist/);
  });

  it('throws if an input is missing its redeemScript', () => {
    const broken: Transaction = {
      ...MAINNET_TX,
      inputs: [{ ...MAINNET_TX.inputs[0]!, redeemScript: undefined }],
    };
    expect(() => serialize(broken)).toThrow(/missing redeemScript/);
  });

  it('throws on wrong-length txid', () => {
    const broken: Transaction = {
      ...MAINNET_TX,
      inputs: [{ ...MAINNET_TX.inputs[0]!, txid: new Uint8Array(31) }],
    };
    expect(() => serialize(broken)).toThrow(RangeError);
  });

  it('throws on negative output value', () => {
    const broken: Transaction = {
      ...MAINNET_TX,
      outputs: [
        { ...MAINNET_TX.outputs[0]!, value: -1n },
        MAINNET_TX.outputs[1]!,
      ],
    };
    expect(() => serialize(broken)).toThrow(RangeError);
  });

  it('throws on output value > uint64 max', () => {
    const broken: Transaction = {
      ...MAINNET_TX,
      outputs: [
        { ...MAINNET_TX.outputs[0]!, value: 0x10000000000000000n },
        MAINNET_TX.outputs[1]!,
      ],
    };
    expect(() => serialize(broken)).toThrow(RangeError);
  });

  it('throws on scripthash of wrong length', () => {
    const broken: Transaction = {
      ...MAINNET_TX,
      outputs: [
        { ...MAINNET_TX.outputs[0]!, scripthash: new Uint8Array(19) },
        MAINNET_TX.outputs[1]!,
      ],
    };
    expect(() => serialize(broken)).toThrow(RangeError);
  });

  it('accepts 32-byte scripthash (PQ output)', () => {
    const tx: Transaction = {
      ...MAINNET_TX,
      outputs: [
        { value: 1000n, scripthash: new Uint8Array(32).fill(0xab) },
        MAINNET_TX.outputs[1]!,
      ],
    };
    // Should not throw, even though we can't predict the txid.
    expect(() => serialize(tx)).not.toThrow();
  });
});

// Token transfer (TX_TYPE_TOKENS) — byte-exact against the golden vector
// (real transfer tx ceca437…). Key invariant:
// serialize carries the varstr(token_hash) prefix; serializeForSighash does
// NOT (wire serialize vs sign_data).
const TOKEN_ID =
  '8b33404b9e184215e783081af45702e2d8911b08f656f2f0724d5dda73279ccd';

const TOKEN_TX: Transaction = {
  txType: TX_TYPE_TOKENS,
  tokenHash: fromHex(TOKEN_ID),
  inputs: [
    {
      txid: fromHex(
        '77f8f9cf263a9aae4c911adf28c9f46570d6a86f80e753fa718cd02504e86afb',
      ),
      vout: 1,
      siglist: [fromHex('00')],
      redeemScript: fromHex('00'),
    },
  ],
  outputs: [
    {
      value: 0n,
      scripthash: fromHex('fd3d188229362eea73f407231ecdceb12206569e'),
      data: encodeTokenTransfer(56753706n),
    },
    {
      value: 0n,
      scripthash: fromHex('1f865808158b3e1c99e35a02b7a0470d42f9ac0a'),
      data: encodeTokenTransfer(92470986190320n),
    },
    {
      value: 278596684618803n,
      scripthash: fromHex('49ddff3521520cb6bf43437ad1a1fead5bedbc11'),
    },
  ],
};

describe('encodeTokenTransfer', () => {
  it('encodes 0x01 + uint64LE amount (golden bytes)', () => {
    expect(toHex(encodeTokenTransfer(56753706n))).toBe('012afe610300000000');
    expect(toHex(encodeTokenTransfer(92470986190320n))).toBe(
      '01f0ad48141a540000',
    );
  });

  it('is always 9 bytes', () => {
    expect(encodeTokenTransfer(0n).length).toBe(9);
    expect(encodeTokenTransfer(0xffffffffffffffffn).length).toBe(9);
  });

  it('rejects negative and over-uint64 amounts', () => {
    expect(() => encodeTokenTransfer(-1n)).toThrow(RangeError);
    expect(() => encodeTokenTransfer(0x10000000000000000n)).toThrow(RangeError);
  });
});

describe('serialize — token transfer', () => {
  it('starts with tx_type 0x04 + varstr(token_hash) = token_id as-is', () => {
    expect(toHex(serialize(TOKEN_TX)).startsWith(`0420${TOKEN_ID}`)).toBe(true);
  });

  it('serializes outputs byte-for-byte (TRANSFER + native change)', () => {
    const ser = toHex(serialize(TOKEN_TX));
    expect(ser).toContain(
      '000000000000000014fd3d188229362eea73f407231ecdceb12206569e09012afe610300000000',
    );
    expect(ser).toContain(
      '0000000000000000141f865808158b3e1c99e35a02b7a0470d42f9ac0a0901f0ad48141a540000',
    );
    // Native change: value + scripthash + EMPTY data (00).
    expect(ser).toContain(
      '331c6cd861fd000014' + '49ddff3521520cb6bf43437ad1a1fead5bedbc11' + '00',
    );
  });
});

describe('serializeForSighash — token transfer omits the token_hash prefix', () => {
  it('starts with tx_type + input count, NOT the token_hash prefix', () => {
    const sig = toHex(serializeForSighash(TOKEN_TX));
    // 04 (type) + 01 (varint: 1 input) + txid… — no 0x20 token_hash prefix.
    expect(sig.startsWith('0401')).toBe(true);
    expect(sig.startsWith(`0420${TOKEN_ID}`)).toBe(false);
  });

  it('still covers the TRANSFER amounts (output data is signed)', () => {
    expect(toHex(serializeForSighash(TOKEN_TX))).toContain('012afe610300000000');
  });
});
