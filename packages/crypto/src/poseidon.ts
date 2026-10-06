import { poseidon1, poseidon2, poseidon3 } from "poseidon-bls12381";
import { assertCanonical } from "./field.js";

// Reject aliases before hashing because the library reduces inputs modulo R.

/** H1(a) = Poseidon255(1). */
export function h1(a: bigint): bigint {
  return poseidon1([assertCanonical(a, "a")]);
}

/** H2(a, b) = Poseidon255(2). */
export function h2(a: bigint, b: bigint): bigint {
  return poseidon2([assertCanonical(a, "a"), assertCanonical(b, "b")]);
}

/** H3(a, b, c) = Poseidon255(3). */
export function h3(a: bigint, b: bigint, c: bigint): bigint {
  return poseidon3([
    assertCanonical(a, "a"),
    assertCanonical(b, "b"),
    assertCanonical(c, "c"),
  ]);
}
