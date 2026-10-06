import { assertCanonical } from "./field.js";
import { h1, h2, h3 } from "./poseidon.js";

export const VALUE_BITS = 64;

export interface Note {
  value: bigint;
  label: bigint;
  nullifier: bigint;
  secret: bigint;
}

export function precommitment(nullifier: bigint, secret: bigint): bigint {
  return h2(nullifier, secret);
}

export function commitment(note: Note): bigint {
  assertCanonical(note.value, "value");
  if (note.value >= 1n << BigInt(VALUE_BITS)) {
    throw new RangeError("value must fit in 64 unsigned bits");
  }
  assertCanonical(note.label, "label");
  return h3(note.value, note.label, precommitment(note.nullifier, note.secret));
}

export function nullifierHash(nullifier: bigint): bigint {
  return h1(nullifier);
}
