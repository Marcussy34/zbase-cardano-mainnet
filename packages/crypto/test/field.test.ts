import assert from "node:assert/strict";
import test from "node:test";
import {
  R,
  assertCanonical,
  bigIntToBytesBE,
  bytesToBigIntBE,
  bytesToHex,
  hexToBytes,
  isCanonical,
} from "../src/field.js";

test("CRY-10 isCanonical checks both field boundaries", () => {
  assert.equal(isCanonical(-1n), false);
  assert.equal(isCanonical(0n), true);
  assert.equal(isCanonical(R - 1n), true);
  assert.equal(isCanonical(R), false);
});

test("CRY-10 assertCanonical preserves canonical values", () => {
  for (const value of [0n, 1n, R - 1n]) {
    assert.equal(assertCanonical(value, "commitment"), value);
  }
});

test("CRY-10 assertCanonical names rejected field inputs", () => {
  for (const value of [-1n, R, R + 1n]) {
    assert.throws(() => assertCanonical(value, "commitment"), {
      name: "RangeError",
      message: /commitment/,
    });
  }
});

test("CRY-10 field validation rejects a forced JavaScript number", () => {
  // These calls also check that TypeScript rejects number arguments.
  // @ts-expect-error Field inputs must be bigint.
  assert.equal(isCanonical(0), false);
  assert.throws(() => {
    // @ts-expect-error Field inputs must be bigint.
    assertCanonical(0, "commitment");
  }, TypeError);
});

test("CRY-10 unsigned bytes use big-endian order and left padding", () => {
  assert.deepEqual(bigIntToBytesBE(0x1234n, 4), Uint8Array.of(0, 0, 0x12, 0x34));
  assert.equal(bytesToBigIntBE(Uint8Array.of(0, 0, 0x12, 0x34)), 0x1234n);
  assert.equal(bytesToBigIntBE(Uint8Array.of(0x80, 0xff)), 0x80ffn);
  assert.deepEqual(bigIntToBytesBE(0n, 4), new Uint8Array(4));
});

test("CRY-10 unsigned bytes round-trip at fixed-width boundaries", () => {
  const cases: [bigint, number][] = [
    [0n, 0],
    [0n, 1],
    [255n, 1],
    [2n ** 32n - 1n, 4],
    [2n ** 64n - 1n, 8],
    [R - 1n, 32],
  ];
  for (const [value, length] of cases) {
    const bytes = bigIntToBytesBE(value, length);
    assert.equal(bytes.length, length);
    assert.equal(bytesToBigIntBE(bytes), value);
  }
  assert.equal(bytesToBigIntBE(new Uint8Array()), 0n);
});

test("CRY-10 unsigned bytes reject negative values and overflow", () => {
  const cases: [bigint, number][] = [
    [2n ** 64n, 8],
    [2n ** 32n, 4],
    [256n, 1],
    [1n, 0],
    [-1n, 8],
  ];
  for (const [value, length] of cases) {
    assert.throws(() => bigIntToBytesBE(value, length), RangeError);
  }
});

test("CRY-10 unsigned bytes reject invalid lengths", () => {
  for (const length of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => bigIntToBytesBE(0n, length), RangeError);
  }
});

test("CRY-10 hex helpers round-trip bytes as lowercase hex", () => {
  const bytes = Uint8Array.of(0, 1, 0x0f, 0x80, 0xab, 0xff);
  assert.equal(bytesToHex(bytes), "00010f80abff");
  assert.deepEqual(hexToBytes("00010f80abff"), bytes);
  assert.deepEqual(hexToBytes("00010F80ABFF"), bytes);
  assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes);
  assert.equal(bytesToHex(new Uint8Array()), "");
  assert.deepEqual(hexToBytes(""), new Uint8Array());
});

test("CRY-10 hexToBytes rejects odd lengths and non-hex characters", () => {
  for (const hex of ["abc", "zz", "0g", "0x01", " 00 ", "00\n\n"]) {
    assert.throws(() => hexToBytes(hex), RangeError);
  }
});
