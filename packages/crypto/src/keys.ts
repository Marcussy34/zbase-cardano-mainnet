import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { R, bytesToBigIntBE } from "./field.js";

function validate(seed: Uint8Array, index: number): void {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new RangeError("seed must be exactly 32 bytes");
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("index must be a non-negative safe integer");
  }
}

function derive(seed: Uint8Array, domain: string, index: number, length: number): Uint8Array {
  // Separate the protocol and purpose so one seed cannot reuse derived keys.
  return hkdf(sha256, seed, new Uint8Array(), utf8ToBytes(`zx402/${domain}/v1/${index}`), length);
}

export function deriveNoteSecrets(seed: Uint8Array, index: number): { nullifier: bigint; secret: bigint } {
  validate(seed, index);
  // Reduce the full 64-byte output, never a truncated digest.
  return {
    nullifier: bytesToBigIntBE(derive(seed, "nullifier", index, 64)) % R,
    secret: bytesToBigIntBE(derive(seed, "secret", index, 64)) % R,
  };
}

export function deriveOneTimeKey(seed: Uint8Array, index: number): Uint8Array {
  validate(seed, index);
  return derive(seed, "onetime", index, 32);
}
