import { bls12_381 } from "@noble/curves/bls12-381.js";

/** A Groth16 proof as snarkjs writes it (proof.json). Coordinates are decimal strings. */
export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol?: string;
  curve?: string;
}

/** A verification key as snarkjs writes it (verification_key.json). */
export interface SnarkjsVk {
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
  nPublic?: number;
  protocol?: string;
  curve?: string;
}

export interface CardanoProof {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
}

export interface CardanoVk {
  alpha: Uint8Array;
  beta: Uint8Array;
  gamma: Uint8Array;
  delta: Uint8Array;
  ic: Uint8Array[];
}

const { G1, G2, fields: { Fp, Fp2 } } = bls12_381;

function coordinate(value: unknown, name: string): bigint {
  if (typeof value !== "string" || value.length === 0 || /[^0-9]/.test(value)) {
    throw new Error(`${name} must be an unsigned decimal string`);
  }
  const result = BigInt(value);
  // Point coordinates use the base field p, not the scalar field r.
  if (result >= Fp.ORDER) {
    throw new Error(`${name} must be below the base field prime`);
  }
  return result;
}

function fp2Coordinate(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${name} must contain [c0, c1]`);
  }
  return Fp2.fromBigTuple([
    coordinate(value[0], `${name}[0]`), coordinate(value[1], `${name}[1]`),
  ]);
}

function compressG1(input: string[], name: string): Uint8Array {
  if (!Array.isArray(input) || input.length !== 3) {
    throw new Error(`${name} must contain [x, y, z]`);
  }
  const x = coordinate(input[0], `${name}.x`);
  const y = coordinate(input[1], `${name}.y`);
  const z = coordinate(input[2], `${name}.z`);
  if (z === 0n) throw new Error(`${name} must not be infinity`);
  if (input[2] !== "1") throw new Error(`${name}.z must be "1"`);
  try {
    const point = G1.Point.fromAffine({ x, y });
    // Noble permits infinity for BLS, but the pool rejects it.
    if (point.is0()) throw new Error("point must not be infinity");
    point.assertValidity();
    return point.toBytes(true);
  } catch (cause) {
    throw new Error(`${name}: ${cause instanceof Error ? cause.message : "invalid point"}`, { cause });
  }
}

function compressG2(input: string[][], name: string): Uint8Array {
  if (!Array.isArray(input) || input.length !== 3) {
    throw new Error(`${name} must contain [x, y, z]`);
  }
  const x = fp2Coordinate(input[0], `${name}.x`);
  const y = fp2Coordinate(input[1], `${name}.y`);
  const z = fp2Coordinate(input[2], `${name}.z`);
  if (Fp2.is0(z)) throw new Error(`${name} must not be infinity`);
  if (input[2]![0] !== "1" || input[2]![1] !== "0") {
    throw new Error(`${name}.z must be ["1", "0"]`);
  }
  try {
    const point = G2.Point.fromAffine({ x, y });
    if (point.is0()) throw new Error("point must not be infinity");
    point.assertValidity();
    // Noble emits c1 before c0 and sets the three Zcash compression flags.
    return point.toBytes(true);
  } catch (cause) {
    throw new Error(`${name}: ${cause instanceof Error ? cause.message : "invalid point"}`, { cause });
  }
}

function checkMetadata(input: { curve?: string; protocol?: string }, name: string): void {
  if (input.curve !== undefined && input.curve !== "bls12381") {
    throw new Error(`${name}.curve must be bls12381`);
  }
  if (input.protocol !== undefined && input.protocol !== "groth16") {
    throw new Error(`${name}.protocol must be groth16`);
  }
}

/** Converts validated proof points to compressed G1 (48), G2 (96), G1 (48) bytes. */
export function proofToCardano(proof: SnarkjsProof): CardanoProof {
  checkMetadata(proof, "proof");
  return {
    a: compressG1(proof.pi_a, "proof.pi_a"),
    b: compressG2(proof.pi_b, "proof.pi_b"),
    c: compressG1(proof.pi_c, "proof.pi_c"),
  };
}

/** Converts validated verification key points to compressed Plutus bytes. */
export function vkToCardano(vk: SnarkjsVk): CardanoVk {
  checkMetadata(vk, "vk");
  if (!Array.isArray(vk.IC)) throw new Error("vk.IC must be an array of points");
  if (vk.nPublic !== undefined) {
    if (!Number.isSafeInteger(vk.nPublic) || vk.nPublic < 0) {
      throw new Error("vk.nPublic must be a nonnegative safe integer");
    }
    if (vk.IC.length !== vk.nPublic + 1) {
      throw new Error("vk.IC must contain nPublic + 1 points");
    }
  }
  return {
    alpha: compressG1(vk.vk_alpha_1, "vk.vk_alpha_1"),
    beta: compressG2(vk.vk_beta_2, "vk.vk_beta_2"),
    gamma: compressG2(vk.vk_gamma_2, "vk.vk_gamma_2"),
    delta: compressG2(vk.vk_delta_2, "vk.vk_delta_2"),
    ic: Array.from(vk.IC, (point, index) => compressG1(point, `vk.IC[${index}]`)),
  };
}
