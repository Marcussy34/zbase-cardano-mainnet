import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import {
  proofToCardano,
  vkToCardano,
  type SnarkjsProof,
  type SnarkjsVk,
} from "../src/points.js";

interface Vectors {
  vk: { alpha_g1: string; beta_g2: string; gamma_g2: string; delta_g2: string; ic: string[] };
  proofs: { name: string; a: string; b: string; c: string; snarkjs_proof: SnarkjsProof }[];
  snarkjs_verification_key: SnarkjsVk;
}

const vectors: Vectors = JSON.parse(readFileSync(
  new URL("../../../docs/vectors/groth16-vectors.json", import.meta.url), "utf8",
));
const { G1, G2, fields: { Fp, Fp2 } } = bls12_381;
const proof = () => structuredClone(vectors.proofs[0]!.snarkjs_proof);
const vk = () => structuredClone(vectors.snarkjs_verification_key);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function rejectsPoint(convert: () => unknown, name: string, reason?: RegExp): void {
  assert.throws(convert, (error: unknown) => error instanceof Error
    && error.message.includes(name) && (reason === undefined || reason.test(error.message)));
}

function roundTripG1(bytes: Uint8Array, input: string[]): void {
  assert.equal(bytes.length, 48);
  assert.deepEqual(G1.Point.fromBytes(bytes).toAffine(), {
    x: BigInt(input[0]!), y: BigInt(input[1]!),
  });
}

function roundTripG2(bytes: Uint8Array, input: string[][]): void {
  assert.equal(bytes.length, 96);
  assert.deepEqual(G2.Point.fromBytes(bytes).toAffine(), {
    x: { c0: BigInt(input[0]![0]!), c1: BigInt(input[0]![1]!) },
    y: { c0: BigInt(input[1]![0]!), c1: BigInt(input[1]![1]!) },
  });
}

test("CRY-08 verification key matches every compressed vector", () => {
  const output = vkToCardano(vk());
  assert.deepEqual({
    alpha_g1: hex(output.alpha), beta_g2: hex(output.beta),
    gamma_g2: hex(output.gamma), delta_g2: hex(output.delta), ic: output.ic.map(hex),
  }, vectors.vk);
});

for (const vector of vectors.proofs) {
  test(`CRY-08 ${vector.name} matches every compressed vector`, () => {
    const output = proofToCardano(vector.snarkjs_proof);
    assert.deepEqual({ a: hex(output.a), b: hex(output.b), c: hex(output.c) }, {
      a: vector.a, b: vector.b, c: vector.c,
    });
  });

  test(`CRY-08 ${vector.name} decompresses to the original affine coordinates`, () => {
    const input = vector.snarkjs_proof;
    const output = proofToCardano(input);
    roundTripG1(output.a, input.pi_a);
    roundTripG2(output.b, input.pi_b);
    roundTripG1(output.c, input.pi_c);
  });
}

test("CRY-08 gamma equals the compressed G2 generator", () => {
  assert.deepEqual(vkToCardano(vk()).gamma, G2.Point.BASE.toBytes(true));
});

test("CRY-08 every key point decompresses to the original affine coordinates", () => {
  const input = vk();
  const output = vkToCardano(input);
  roundTripG1(output.alpha, input.vk_alpha_1);
  roundTripG2(output.beta, input.vk_beta_2);
  roundTripG2(output.gamma, input.vk_gamma_2);
  roundTripG2(output.delta, input.vk_delta_2);
  assert.equal(output.ic.length, input.IC.length);
  output.ic.forEach((bytes, index) => roundTripG1(bytes, input.IC[index]!));
});

test("CRY-08 proof metadata is optional", () => {
  const input = proof();
  delete input.curve;
  delete input.protocol;
  assert.equal(hex(proofToCardano(input).a), vectors.proofs[0]!.a);
});

test("CRY-08 key metadata and nPublic are optional", () => {
  const input = vk();
  delete input.curve;
  delete input.protocol;
  delete input.nPublic;
  assert.deepEqual(vkToCardano(input).ic.map(hex), vectors.vk.ic);
});

for (const [label, value] of [
  ["empty string", ""], ["hexadecimal", "0x01"], ["negative", "-1"],
  ["signed", "+1"], ["fraction", "1.5"], ["exponent", "1e2"],
  ["whitespace", " 1"], ["newline", "1\n"], ["letters", "one"],
  ["number", 1], ["bigint", 1n], ["null", null],
] as const) {
  test(`CRY-08 G1 rejects a coordinate supplied as ${label}`, () => {
    const input = proof();
    input.pi_a[0] = value as string;
    rejectsPoint(() => proofToCardano(input), "pi_a");
  });

  test(`CRY-08 G2 rejects a coordinate supplied as ${label}`, () => {
    const input = proof();
    input.pi_b[1]![1] = value as string;
    rejectsPoint(() => proofToCardano(input), "pi_b");
  });
}

for (const value of [Fp.ORDER, Fp.ORDER + 1n]) {
  for (const index of [0, 1]) {
    test(`CRY-08 G1 rejects coordinate ${index} at p + ${value - Fp.ORDER}`, () => {
      const input = proof();
      input.pi_a[index] = value.toString();
      rejectsPoint(() => proofToCardano(input), "pi_a");
    });
    for (const component of [0, 1]) {
      test(`CRY-08 G2 rejects coordinate ${index}:${component} at p + ${value - Fp.ORDER}`, () => {
        const input = proof();
        input.pi_b[index]![component] = value.toString();
        rejectsPoint(() => proofToCardano(input), "pi_b");
      });
    }
  }
}

for (const z of ["2", "01", "invalid"]) {
  test(`CRY-08 G1 rejects projective z ${z}`, () => {
    const input = proof();
    input.pi_a[2] = z;
    rejectsPoint(() => proofToCardano(input), "pi_a");
  });
}

for (const z of [["2", "0"], ["1", "1"], ["01", "0"], ["1", "00"], ["invalid", "0"]]) {
  test(`CRY-08 G2 rejects projective z ${z.join(":")}`, () => {
    const input = proof();
    input.pi_b[2] = z;
    rejectsPoint(() => proofToCardano(input), "pi_b");
  });
}

test("CRY-08 G1 rejects projective infinity", () => {
  const input = proof();
  input.pi_a[2] = "0";
  rejectsPoint(() => proofToCardano(input), "pi_a", /infinity/);
});

test("CRY-08 G2 rejects projective infinity", () => {
  const input = proof();
  input.pi_b[2] = ["0", "0"];
  rejectsPoint(() => proofToCardano(input), "pi_b", /infinity/);
});

test("CRY-08 G1 rejects the affine infinity sentinel", () => {
  const input = proof();
  input.pi_a = ["0", "0", "1"];
  rejectsPoint(() => proofToCardano(input), "pi_a", /infinity/);
});

test("CRY-08 G2 rejects the affine infinity sentinel", () => {
  const input = proof();
  input.pi_b = [["0", "0"], ["0", "0"], ["1", "0"]];
  rejectsPoint(() => proofToCardano(input), "pi_b", /infinity/);
});

for (const field of ["pi_a", "pi_c"] as const) {
  test(`CRY-08 ${field} rejects an off-curve point and names it`, () => {
    const input = proof();
    input[field][0] = (BigInt(input[field][0]!) + 1n).toString();
    rejectsPoint(() => proofToCardano(input), field);
  });
}

test("CRY-08 pi_b rejects an off-curve point and names it", () => {
  const input = proof();
  input.pi_b[0]![0] = (BigInt(input.pi_b[0]![0]!) + 1n).toString();
  rejectsPoint(() => proofToCardano(input), "pi_b");
});

test("CRY-08 vk_alpha_1 rejects an off-curve point and names it", () => {
  const input = vk();
  input.vk_alpha_1[0] = (BigInt(input.vk_alpha_1[0]!) + 1n).toString();
  rejectsPoint(() => vkToCardano(input), "vk_alpha_1");
});

for (const field of ["vk_beta_2", "vk_gamma_2", "vk_delta_2"] as const) {
  test(`CRY-08 ${field} rejects an off-curve point and names it`, () => {
    const input = vk();
    input[field][0]![0] = (BigInt(input[field][0]![0]!) + 1n).toString();
    rejectsPoint(() => vkToCardano(input), field);
  });
}

for (let index = 0; index < vectors.vk.ic.length; index += 1) {
  test(`CRY-08 IC[${index}] rejects an off-curve point and names it`, () => {
    const input = vk();
    input.IC[index]![0] = (BigInt(input.IC[index]![0]!) + 1n).toString();
    rejectsPoint(() => vkToCardano(input), `IC[${index}]`);
  });
}

test("CRY-08 G1 rejects a curve point outside the prime-order subgroup", () => {
  // (0, 2) satisfies y^2 = x^3 + 4 but has order three.
  const input = proof();
  input.pi_a = ["0", "2", "1"];
  rejectsPoint(() => proofToCardano(input), "pi_a", /subgroup/);
});

test("CRY-08 G2 rejects a curve point outside the prime-order subgroup", () => {
  // Taking a square root gives a curve point without clearing its cofactor.
  const x = Fp2.fromBigTuple([0n, 1n]);
  const y = Fp2.sqrt(Fp2.add(Fp2.mul(Fp2.sqr(x), x), G2.Point.CURVE().b));
  assert.equal(G2.Point.fromAffine({ x, y }).isTorsionFree(), false);
  const input = proof();
  input.pi_b = [["0", "1"], [y.c0.toString(), y.c1.toString()], ["1", "0"]];
  rejectsPoint(() => proofToCardano(input), "pi_b", /subgroup/);
});

for (const [field, value] of [["curve", "bls12-381"], ["protocol", "plonk"]] as const) {
  test(`CRY-08 proof rejects an unsupported ${field}`, () => {
    const input = proof();
    input[field] = value;
    rejectsPoint(() => proofToCardano(input), field);
  });
  test(`CRY-08 key rejects an unsupported ${field}`, () => {
    const input = vk();
    input[field] = value;
    rejectsPoint(() => vkToCardano(input), field);
  });
}

test("CRY-08 key rejects an IC count different from nPublic + 1", () => {
  const input = vk();
  input.IC.pop();
  rejectsPoint(() => vkToCardano(input), "IC");
});

for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`CRY-08 key rejects invalid nPublic ${count}`, () => {
    const input = vk();
    input.nPublic = count;
    rejectsPoint(() => vkToCardano(input), "nPublic");
  });
}

for (const point of [[], ["1", "2"], ["1", "2", "1", "0"]]) {
  test(`CRY-08 G1 rejects a point with ${point.length} coordinates`, () => {
    const input = proof();
    input.pi_a = point;
    rejectsPoint(() => proofToCardano(input), "pi_a");
  });
}

test("CRY-08 G2 rejects a missing projective coordinate", () => {
  const input = proof();
  input.pi_b.pop();
  rejectsPoint(() => proofToCardano(input), "pi_b");
});

for (const coordinate of [0, 1, 2]) {
  test(`CRY-08 G2 rejects a malformed coordinate pair ${coordinate}`, () => {
    const input = proof();
    input.pi_b[coordinate]!.pop();
    rejectsPoint(() => proofToCardano(input), "pi_b");
  });
}
