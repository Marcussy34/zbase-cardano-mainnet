import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { R, h1, h2, h3, isCanonical } from "../src/index.js";

interface KnownAnswer {
  inputs: string[];
  output: string;
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../docs/vectors/poseidon-vectors.json", import.meta.url),
    "utf8",
  ),
) as { h1: KnownAnswer[]; h2: KnownAnswer[]; h3: KnownAnswer[] };

const wrappers = [
  { name: "h1", hash: h1, arity: 1, answers: vectors.h1 },
  { name: "h2", hash: h2, arity: 2, answers: vectors.h2 },
  { name: "h3", hash: h3, arity: 3, answers: vectors.h3 },
] satisfies {
  name: string;
  hash: (...inputs: bigint[]) => bigint;
  arity: number;
  answers: KnownAnswer[];
}[];

for (const { name, hash, arity, answers } of wrappers) {
  const call: (...inputs: bigint[]) => bigint = hash;
  for (const [index, { inputs, output }] of answers.entries()) {
    test(`CRY-01 ${name} matches known answer ${index + 1}`, () => {
      assert.equal(inputs.length, arity);
      const result = call(...inputs.map(BigInt));
      assert.equal(result, BigInt(output));
      assert.equal(typeof result, "bigint");
      assert.equal(isCanonical(result), true);
    });
  }

  for (let position = 0; position < arity; position += 1) {
    for (const [label, invalid] of [
      ["R", R],
      ["R + 1", R + 1n],
      ["-1", -1n],
    ] as const) {
      test(`CRY-01 ${name} rejects ${label} at argument ${position + 1}`, () => {
        const inputs = Array<bigint>(arity).fill(0n);
        inputs[position] = invalid;
        assert.throws(() => call(...inputs), RangeError);
      });
    }
  }
}

test("CRY-01 h2 matches the independent hexadecimal cross-check", () => {
  assert.equal(
    h2(1n, 2n),
    0x3fb8310b0e962b75bffec5f9cfcbf3f965a7b1d2dcac8d95ccb13d434e08e5fan,
  );
});

const numberCalls = [
  ["h1 argument 1", () => {
    // @ts-expect-error Poseidon inputs must be bigint.
    h1(0);
  }],
  ["h2 argument 1", () => {
    // @ts-expect-error Poseidon inputs must be bigint.
    h2(0, 0n);
  }],
  ["h2 argument 2", () => {
    // @ts-expect-error Poseidon inputs must be bigint.
    h2(0n, 0);
  }],
  ["h3 argument 1", () => {
    // @ts-expect-error Poseidon inputs must be bigint.
    h3(0, 0n, 0n);
  }],
  ["h3 argument 2", () => {
    // @ts-expect-error Poseidon inputs must be bigint.
    h3(0n, 0, 0n);
  }],
  ["h3 argument 3", () => {
    // @ts-expect-error Poseidon inputs must be bigint.
    h3(0n, 0n, 0);
  }],
] as const;

for (const [label, call] of numberCalls) {
  test(`CRY-01 ${label} rejects a forced JavaScript number`, () => {
    assert.throws(call, TypeError);
  });
}
