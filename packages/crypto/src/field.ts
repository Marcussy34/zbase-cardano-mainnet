/** BLS12-381 scalar field prime r. */
export const R: bigint =
  0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

/** True when x is a bigint and 0 <= x < R. */
export function isCanonical(x: bigint): boolean {
  return typeof x === "bigint" && x >= 0n && x < R;
}

/** Returns a canonical bigint, or throws with the input name. */
export function assertCanonical(x: bigint, what: string): bigint {
  if (typeof x !== "bigint") {
    throw new TypeError(`${what} must be a bigint`);
  }
  if (!isCanonical(x)) {
    throw new RangeError(`${what} must satisfy 0 <= x < R`);
  }
  return x;
}

/** Reads bytes as an unsigned big-endian integer (SPEC 4.8 int_be). */
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/** Encodes an unsigned integer at a fixed width, rejecting overflow. */
export function bigIntToBytesBE(x: bigint, length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("length must be a nonnegative safe integer");
  }
  if (x < 0n || x >= (1n << (BigInt(length) * 8n))) {
    throw new RangeError("x does not fit the unsigned byte length");
  }
  const bytes = new Uint8Array(length);
  let remaining = x;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

/** Returns lowercase hex without a 0x prefix. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads unprefixed hex, rejecting odd lengths and non-hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new RangeError("hex must contain complete hexadecimal byte pairs");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
