import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bech32 } from "@scure/base";
import {
  addressFromBech32,
  addressToBech32,
  contextFor,
  intentBytes,
  labelFor,
  labelPreimage,
  nullifierKey,
} from "../src/encoding.js";
import type { Credential, PayoutAddress, SettleIntent } from "../src/encoding.js";
import { R, bytesToHex, hexToBytes } from "../src/field.js";

interface LabelVector {
  pool_id: string;
  tx_id: string;
  output_index: number;
  refund_key_hash: string;
  preimage_hex: string;
  label: string;
}

interface ContextVector {
  valid_until: number;
  intent_bytes_hex: string;
  context: string;
}

interface NullifierVector {
  nullifier_hash: string;
  key_hex: string;
}

const vectors = JSON.parse(readFileSync(
  new URL("../../../docs/vectors/encoding-vectors.json", import.meta.url), "utf8",
)) as {
  label_1: LabelVector;
  label_2: LabelVector;
  context_1: ContextVector;
  context_2: ContextVector;
  nullifier_key_1: NullifierVector;
  nullifier_key_2: NullifierVector;
};

function labelInput(vector = vectors.label_1): Parameters<typeof labelFor>[0] {
  return {
    poolId: hexToBytes(vector.pool_id),
    txId: hexToBytes(vector.tx_id),
    outputIndex: vector.output_index,
    refundKeyHash: hexToBytes(vector.refund_key_hash),
  };
}

function credential(kind: Credential["kind"], byte: number): Credential {
  return { kind, hash: new Uint8Array(28).fill(byte) };
}

// The JSON omits payout inputs. These inputs come from TEST-VECTORS section 7.
function contextInput(second = false): SettleIntent {
  return {
    poolId: hexToBytes(vectors.label_1.pool_id),
    payouts: second ? [
      {
        address: { payment: credential("script", 0x55), stake: credential("key", 0x66) },
        amount: 12_345_678n,
        datumHash: new Uint8Array(32).fill(0x77),
      },
      {
        address: { payment: credential("key", 0x44), stake: null },
        amount: 1_000_000n,
        datumHash: null,
      },
    ] : [{
      address: { payment: credential("key", 0x44), stake: null },
      amount: 5_000_000n,
      datumHash: null,
    }],
    relayer: second ? new Uint8Array(28).fill(0x88) : null,
    validUntil: BigInt((second ? vectors.context_2 : vectors.context_1).valid_until),
  };
}

for (const [name, vector] of Object.entries({ label_1: vectors.label_1, label_2: vectors.label_2 })) {
  test(`CRY-05 ${name} matches the preimage and label known answers`, () => {
    assert.equal(bytesToHex(labelPreimage(labelInput(vector))), vector.preimage_hex);
    assert.equal(labelFor(labelInput(vector)), BigInt(vector.label));
  });
}

for (const second of [false, true]) {
  test(`CRY-06 context_${second ? 2 : 1} matches intent bytes and context`, () => {
    const vector = second ? vectors.context_2 : vectors.context_1;
    assert.equal(bytesToHex(intentBytes(contextInput(second))), vector.intent_bytes_hex);
    assert.equal(contextFor(contextInput(second)), BigInt(vector.context));
  });
}

for (const [name, vector] of Object.entries({
  nullifier_key_1: vectors.nullifier_key_1,
  nullifier_key_2: vectors.nullifier_key_2,
})) {
  test(`CRY-07 ${name} matches the 32-byte big-endian key`, () => {
    const key = nullifierKey(BigInt(vector.nullifier_hash));
    assert.equal(key.length, 32);
    assert.equal(bytesToHex(key), vector.key_hex);
  });
}

test("CRY-07 zero nullifier hash has a 32-byte zero key", () => {
  assert.deepEqual(nullifierKey(0n), new Uint8Array(32));
});

for (const [field, length] of [["poolId", 28], ["txId", 32], ["refundKeyHash", 28]] as const) {
  for (const size of [length - 1, length + 1]) {
    test(`CRY-10 label rejects ${field} of ${size} bytes`, () => {
      const input = { ...labelInput(), [field]: new Uint8Array(size) };
      for (const encode of [labelPreimage, labelFor]) {
        assert.throws(() => encode(input), { name: "RangeError", message: new RegExp(field) });
      }
    });
  }
}

for (const outputIndex of [-1, 0.5, 2 ** 32, NaN, Infinity]) {
  test(`CRY-10 label rejects outputIndex ${outputIndex}`, () => {
    for (const encode of [labelPreimage, labelFor]) {
      assert.throws(() => encode({ ...labelInput(), outputIndex }), {
        name: "RangeError", message: /outputIndex/,
      });
    }
  });
}

test("CRY-10 label preserves both unsigned 32-bit outputIndex boundaries", () => {
  for (const [outputIndex, expected] of [[0, "00000000"], [2 ** 32 - 1, "ffffffff"]] as const) {
    const preimage = labelPreimage({ ...labelInput(), outputIndex });
    assert.equal(bytesToHex(preimage.slice(-32, -28)), expected);
  }
});

const intentRejections: { name: string; field: RegExp; change: (intent: SettleIntent) => void }[] = [];
for (const size of [27, 29]) {
  intentRejections.push(
    { name: `poolId of ${size} bytes`, field: /poolId/, change: (i) => { i.poolId = new Uint8Array(size); } },
    { name: `payment hash of ${size} bytes`, field: /payment.*hash/, change: (i) => { i.payouts[0]!.address.payment.hash = new Uint8Array(size); } },
    { name: `stake hash of ${size} bytes`, field: /stake.*hash/, change: (i) => { i.payouts[0]!.address.stake!.hash = new Uint8Array(size); } },
    { name: `relayer of ${size} bytes`, field: /relayer/, change: (i) => { i.relayer = new Uint8Array(size); } },
  );
}
for (const size of [31, 33]) {
  intentRejections.push({ name: `datumHash of ${size} bytes`, field: /datumHash/, change: (i) => { i.payouts[0]!.datumHash = new Uint8Array(size); } });
}
for (const value of [-1n, 2n ** 64n]) {
  intentRejections.push(
    { name: `amount ${value}`, field: /amount/, change: (i) => { i.payouts[0]!.amount = value; } },
    { name: `validUntil ${value}`, field: /validUntil/, change: (i) => { i.validUntil = value; } },
  );
}
for (const count of [0, 5]) {
  intentRejections.push({ name: `${count} payouts`, field: /payouts/, change: (i) => { i.payouts = Array.from({ length: count }, () => i.payouts[0]!); } });
}
for (const { name, field, change } of intentRejections) {
  test(`CRY-10 intent rejects ${name}`, () => {
    const intent = contextInput(true);
    change(intent);
    for (const encode of [intentBytes, contextFor]) {
      assert.throws(() => encode(intent), { name: "RangeError", message: field });
    }
  });
}

test("CRY-10 intent accepts four payouts and both unsigned 64-bit boundaries", () => {
  for (const [value, expected] of [[0n, "0000000000000000"], [2n ** 64n - 1n, "ffffffffffffffff"]] as const) {
    const intent = contextInput();
    intent.payouts[0]!.amount = value;
    intent.validUntil = value;
    intent.payouts = Array.from({ length: 4 }, () => intent.payouts[0]!);
    const bytes = intentBytes(intent);
    assert.equal(bytes[43], 4);
    assert.equal(bytesToHex(bytes.slice(74, 82)), expected);
    assert.equal(bytesToHex(bytes.slice(-8)), expected);
  }
});

for (const value of [-1n, R, R + 1n]) {
  test(`CRY-10 nullifierKey rejects non-canonical value ${value}`, () => {
    assert.throws(() => nullifierKey(value), { name: "RangeError", message: /nullifierHash/ });
  });
}

function rawAddress(header: number, length: number, prefix = "addr"): string {
  const bytes = new Uint8Array(length).fill(0x44);
  if (length > 0) bytes[0] = header;
  return bech32.encode(prefix, bech32.toWords(bytes), false);
}

const addressCases: [number, Credential["kind"], Credential["kind"] | null][] = [
  [0, "key", "key"], [1, "script", "key"],
  [2, "key", "script"], [3, "script", "script"],
  [6, "key", null], [7, "script", null],
];
for (const [type, paymentKind, stakeKind] of addressCases) {
  test(`CRY-10 mainnet address type ${type} matches raw bytes and round-trips`, () => {
    const address: PayoutAddress = {
      payment: credential(paymentKind, 0x44),
      stake: stakeKind === null ? null : credential(stakeKind, 0x66),
    };
    const bytes = Uint8Array.from([
      (type << 4) | 1, ...address.payment.hash, ...(address.stake?.hash ?? []),
    ]);
    const encoded = bech32.encode("addr", bech32.toWords(bytes), false);
    assert.deepEqual(addressFromBech32(encoded), address);
    assert.equal(addressToBech32(address), encoded);
    assert.deepEqual(addressFromBech32(addressToBech32(address)), address);
  });

  test(`CRY-06 address type ${type} preserves context through Bech32`, () => {
    const intent = contextInput();
    intent.payouts[0]!.address = {
      payment: credential(paymentKind, 0x44),
      stake: stakeKind === null ? null : credential(stakeKind, 0x66),
    };
    const before = contextFor(intent);
    intent.payouts[0]!.address = addressFromBech32(addressToBech32(intent.payouts[0]!.address));
    assert.equal(contextFor(intent), before);
  });
}

for (const [type, length, name] of [
  [4, 32, "key pointer"], [5, 32, "script pointer"],
  [14, 29, "key reward"], [15, 29, "script reward"], [8, 29, "Byron"],
  [9, 29, "reserved"],
] as const) {
  test(`CRY-10 address rejects ${name} type ${type}`, () => {
    assert.throws(() => addressFromBech32(rawAddress((type << 4) | 1, length)), RangeError);
  });
}

for (const [header, prefix] of [[0x60, "addr"], [0x61, "addr_test"], [0x62, "addr"], [0x61, "stake"]] as const) {
  test(`CRY-10 address rejects header ${header} with prefix ${prefix}`, () => {
    assert.throws(() => addressFromBech32(rawAddress(header, 29, prefix)), RangeError);
  });
}

for (const [header, length] of [[0x01, 0], [0x01, 56], [0x01, 58], [0x61, 28], [0x61, 30]]) {
  test(`CRY-10 address rejects payload length ${length} for header ${header}`, () => {
    assert.throws(() => addressFromBech32(rawAddress(header!, length!)), RangeError);
  });
}

test("CRY-10 address rejects a bad checksum", () => {
  const address = rawAddress(0x61, 29);
  const corrupted = address.slice(0, -1) + (address.endsWith("q") ? "p" : "q");
  assert.throws(() => addressFromBech32(corrupted), RangeError);
});

test("CRY-10 address rejects nonzero Bech32 padding", () => {
  const words = bech32.toWords(new Uint8Array(29).fill(0x61));
  words[words.length - 1] = words[words.length - 1]! | 1;
  const address = bech32.encode("addr", words, false);
  assert.throws(() => addressFromBech32(address), RangeError);
});

for (const field of ["payment", "stake"] as const) {
  for (const size of [27, 29]) {
    test(`CRY-10 addressToBech32 rejects ${field} hash of ${size} bytes`, () => {
      const address: PayoutAddress = { payment: credential("key", 0x44), stake: credential("script", 0x66) };
      address[field]!.hash = new Uint8Array(size);
      assert.throws(() => addressToBech32(address), { name: "RangeError", message: new RegExp(`${field}.*hash`) });
    });
  }

  test(`CRY-10 encoders reject an unknown ${field} credential kind`, () => {
    const intent = contextInput(true);
    // Exercise JavaScript callers whose values bypass TypeScript's union.
    intent.payouts[0]!.address[field]!.kind = "unknown" as Credential["kind"];
    for (const encode of [intentBytes, contextFor]) {
      assert.throws(() => encode(intent), { name: "RangeError", message: new RegExp(`${field}.*kind`) });
    }
    assert.throws(() => addressToBech32(intent.payouts[0]!.address), {
      name: "RangeError", message: new RegExp(`${field}.*kind`),
    });
  });
}
