import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitment, h1, h2, h3, MerkleTree, nullifierHash, precommitment, rootFromPath, ZERO_HASHES } from "@zx402/crypto";
import vectors from "../../docs/vectors/poseidon-vectors.json" with { type: "json" };
import {
  checkWitness,
  compileCircuit,
  compileTemplate,
  constraintCount,
  expectNoWitness,
  witness,
} from "./harness.js";

const fieldPrime = BigInt(vectors.meta.field_prime);
const note = {
  nullifier: BigInt(vectors.note_example.nullifier),
  secret: BigInt(vectors.note_example.secret),
  value: BigInt(vectors.note_example.value),
  label: BigInt(vectors.note_example.label),
};

function library(file: string, template: string, parameters = "") {
  // Keep the numeric input in the optimized witness so changing one output bit cannot change it implicitly.
  const publicInputs = template === "Num2Bits" ? " {public [in]}" : "";
  return compileTemplate(`${template}${parameters}`, `pragma circom 2.2.0;
include "../../src/lib/${file}.circom";
component main${publicInputs} = ${template}(${parameters});
`);
}

test("harness: compiles, caches, checks real witnesses, and rejects tampering", async () => {
  const source = `pragma circom 2.2.0;
template Square() {
    signal input in;
    signal output out;
    out <== in * in;
}
component main = Square();
`;
  const compiled = await compileTemplate("harness_square", source);
  const values = await witness(compiled, { in: 5n });
  assert.equal(values[1], 25n);
  assert.equal(await constraintCount(compiled), 1);
  assert.equal(await checkWitness(compiled, values), true);
  assert.equal(await checkWitness(compiled, [values[0]!, 26n, ...values.slice(2)]), false);
  await expectNoWitness(compiled, {});
  const modified = (await stat(compiled.r1cs)).mtimeMs;
  assert.equal((await compileTemplate("harness_square", source)).cached, true);
  assert.equal((await stat(compiled.r1cs)).mtimeMs, modified);
  const path = fileURLToPath(new URL("../build/test/harness_square.circom", import.meta.url));
  const existing = await compileCircuit(path);
  assert.equal((await witness(existing, { in: 6n }))[1], 36n);
  const changed = await compileTemplate("harness_square", source.replace("in * in", "in * in + 1"));
  assert.equal(changed.cached, false);
  assert.equal((await witness(changed, { in: 5n }))[1], 26n);
});

test("CIR-P01: Poseidon255 O2 constraint counts match SPEC 5.4", async () => {
  for (const [arity, count] of [[1, 213], [2, 237], [3, 261]]) {
    const compiled = await compileTemplate(`poseidon${arity}`, `pragma circom 2.2.0;
include "poseidon-bls12381-circom/circuits/poseidon255.circom";
component main = Poseidon255(${arity});
`);
    assert.equal(await constraintCount(compiled), count, `Poseidon255(${arity})`);
  }
});

test("CIR-P01: Precommitment matches H2 for the note and all arity-two vectors", async () => {
  const compiled = await library("note", "Precommitment");
  const cases = [...vectors.h2, { inputs: [vectors.note_example.nullifier, vectors.note_example.secret], output: vectors.note_example.precommitment }];
  for (const vector of cases) {
    const [nullifier, secret] = vector.inputs.map(BigInt);
    const values = await witness(compiled, { nullifier: nullifier!, secret: secret! });
    assert.equal(values[1], h2(nullifier!, secret!));
    assert.equal(values[1], BigInt(vector.output));
    assert.equal(await checkWitness(compiled, values), true);
  }
  assert.equal(precommitment(note.nullifier, note.secret), BigInt(vectors.note_example.precommitment));
});

test("CIR-P01: Commitment matches H3 for the note and all arity-three vectors", async () => {
  const compiled = await library("note", "Commitment");
  const cases = [...vectors.h3, { inputs: [vectors.note_example.value, vectors.note_example.label, vectors.note_example.precommitment], output: vectors.note_example.commitment }];
  for (const vector of cases) {
    const [value, label, precommitment] = vector.inputs.map(BigInt);
    const values = await witness(compiled, { value: value!, label: label!, precommitment: precommitment! });
    assert.equal(values[1], h3(value!, label!, precommitment!));
    assert.equal(values[1], BigInt(vector.output));
    assert.equal(await checkWitness(compiled, values), true);
  }
  assert.equal(commitment(note), BigInt(vectors.note_example.commitment));
});

test("CIR-P01: NullifierHash matches H1 for the note and all arity-one vectors", async () => {
  const compiled = await library("note", "NullifierHash");
  const cases = [...vectors.h1, { inputs: [vectors.note_example.nullifier], output: vectors.note_example.nullifierHash }];
  for (const vector of cases) {
    const nullifier = BigInt(vector.inputs[0]!);
    const values = await witness(compiled, { nullifier });
    assert.equal(values[1], h1(nullifier));
    assert.equal(values[1], BigInt(vector.output));
    assert.equal(await checkWitness(compiled, values), true);
  }
  assert.equal(nullifierHash(note.nullifier), BigInt(vectors.note_example.nullifierHash));
});

test("gadgets: Num2Bits(64) accepts the boundaries and rejects overflow", async () => {
  const compiled = await library("gadgets", "Num2Bits", "64");
  for (const input of [0n, 1n, (1n << 64n) - 1n]) {
    const values = await witness(compiled, { in: input });
    assert.deepEqual(values.slice(1, 65), Array.from({ length: 64 }, (_, i) => (input >> BigInt(i)) & 1n));
    assert.equal(await checkWitness(compiled, values), true);
  }
  await expectNoWitness(compiled, { in: 1n << 64n });
});

test("gadgets: Num2Bits(64) constraints reject a changed bit", async () => {
  const compiled = await library("gadgets", "Num2Bits", "64");
  const values = await witness(compiled, { in: 1n });
  assert.equal(await checkWitness(compiled, values), true);
  values[1] = 0n;
  assert.equal(await checkWitness(compiled, values), false);
});

test("gadgets: IsZero detects zero throughout the field", async () => {
  const compiled = await library("gadgets", "IsZero");
  for (const [input, output] of [[0n, 1n], [5n, 0n], [fieldPrime - 1n, 0n]]) {
    const values = await witness(compiled, { in: input! });
    assert.equal(values[1], output);
    assert.equal(await checkWitness(compiled, values), true);
  }
});

for (const [input, forged] of [[5n, 1n], [0n, 0n]]) {
  test(`gadgets: IsZero constraints reject output ${forged} for input ${input}`, async () => {
    const compiled = await library("gadgets", "IsZero");
    const values = await witness(compiled, { in: input! });
    assert.equal(await checkWitness(compiled, values), true);
    values[1] = forged!;
    assert.equal(await checkWitness(compiled, values), false);
  });
}

test("gadgets: IsEqual handles equal and unequal inputs", async () => {
  const compiled = await library("gadgets", "IsEqual");
  for (const [left, right, expected] of [[0n, 0n, 1n], [5n, 5n, 1n], [5n, 0n, 0n], [0n, fieldPrime - 1n, 0n]]) {
    const values = await witness(compiled, { in: [left!, right!] });
    assert.equal(values[1], expected);
    assert.equal(await checkWitness(compiled, values), true);
  }
});

test("gadgets: Mux2 orders values using a boolean selector", async () => {
  const compiled = await library("gadgets", "Mux2");
  for (const selector of [0n, 1n]) {
    const values = await witness(compiled, { selector, in: [5n, 7n] });
    assert.deepEqual(values.slice(1, 3), selector === 0n ? [5n, 7n] : [7n, 5n]);
    assert.equal(await checkWitness(compiled, values), true);
    values[1] = values[1]! + 1n;
    assert.equal(await checkWitness(compiled, values), false);
  }
  await expectNoWitness(compiled, { selector: 2n, in: [5n, 7n] });
});

test("merkle: MerkleRoot(32) matches every leaf of a five-leaf tree", async (t) => {
  const compiled = await library("merkle", "MerkleRoot", "32");
  const leaves = [11n, 22n, 33n, 44n, 55n];
  const tree = MerkleTree.fromLeaves(leaves);
  for (const [index, leaf] of leaves.entries()) {
    const siblings = tree.path(index).siblings;
    const values = await witness(compiled, { leaf, index, siblings });
    assert.equal(values[1], tree.root);
    assert.equal(values[1], rootFromPath(leaf, index, siblings));
    assert.equal(await checkWitness(compiled, values), true);
  }
  t.diagnostic(`MerkleRoot(32): ${await constraintCount(compiled)} constraints; compile ${compiled.compileTimeMs.toFixed(2)} ms; cached ${compiled.cached}`);
});

test("merkle: MerkleRoot(32) matches both tree examples from the vectors", async () => {
  const compiled = await library("merkle", "MerkleRoot", "32");
  for (const vector of [vectors.tree_example_1, vectors.tree_example_2]) {
    const tree = MerkleTree.fromLeaves(vector.leaves.map(({ leaf }) => BigInt(leaf)));
    assert.equal(tree.root, BigInt(vector.root));
    for (const { index, leaf } of vector.leaves) {
      const values = await witness(compiled, { leaf, index, siblings: tree.path(index).siblings });
      assert.equal(values[1], BigInt(vector.root));
      assert.equal(await checkWitness(compiled, values), true);
    }
  }
  assert.deepEqual(MerkleTree.fromLeaves([commitment(note)]).path(0).siblings, ZERO_HASHES.slice(0, 32));
});

test("merkle: MerkleRoot(32) uses all 32 index bits in least-significant-first order", async () => {
  const compiled = await library("merkle", "MerkleRoot", "32");
  const siblings = Array.from({ length: 32 }, (_, i) => BigInt(i + 1));
  for (const index of [2 ** 31, 2 ** 32 - 1]) {
    const values = await witness(compiled, { leaf: 77n, index, siblings });
    assert.equal(values[1], rootFromPath(77n, index, siblings));
    assert.equal(await checkWitness(compiled, values), true);
  }
});

test("merkle: MerkleRoot(32) changes its root for a wrong sibling", async () => {
  const compiled = await library("merkle", "MerkleRoot", "32");
  const tree = MerkleTree.fromLeaves([11n, 22n]);
  const siblings = tree.path(1).siblings;
  const valid = { leaf: 22n, index: 1, siblings };
  assert.equal((await witness(compiled, valid))[1], tree.root);
  const wrong = [...siblings];
  wrong[0] = (wrong[0]! + 1n) % fieldPrime;
  assert.notEqual((await witness(compiled, { ...valid, siblings: wrong }))[1], tree.root);
});

test("merkle: MerkleRoot(32) rejects index overflow", async () => {
  const compiled = await library("merkle", "MerkleRoot", "32");
  const valid = { leaf: 0n, index: 0n, siblings: [...ZERO_HASHES.slice(0, 32)] };
  assert.equal((await witness(compiled, valid))[1], BigInt(vectors.empty_root));
  await expectNoWitness(compiled, { ...valid, index: 1n << 32n });
});

test("merkle: enabled MerkleAppend(32) matches appends at sizes 0, 1, 2, and 5", async (t) => {
  const compiled = await library("merkle", "MerkleAppend", "32");
  for (const size of [0, 1, 2, 5]) {
    const tree = MerkleTree.fromLeaves([11n, 22n, 33n, 44n, 55n].slice(0, size));
    const input = { enabled: 1n, oldRoot: tree.root, index: tree.size, leaf: 66n, siblings: tree.path(tree.size).siblings };
    tree.append(input.leaf);
    const values = await witness(compiled, input);
    assert.equal(values[1], tree.root);
    assert.equal(await checkWitness(compiled, values), true);
    values[1] = (values[1]! + 1n) % fieldPrime;
    assert.equal(await checkWitness(compiled, values), false);
  }
  t.diagnostic(`MerkleAppend(32): ${await constraintCount(compiled)} constraints; compile ${compiled.compileTimeMs.toFixed(2)} ms; cached ${compiled.cached}`);
});

test("merkle: enabled MerkleAppend(32) rejects an occupied slot", async () => {
  const compiled = await library("merkle", "MerkleAppend", "32");
  const empty = MerkleTree.empty();
  const input = { enabled: 1n, oldRoot: empty.root, index: 0, leaf: 22n, siblings: empty.path(0).siblings };
  assert.equal(await checkWitness(compiled, await witness(compiled, input)), true);
  // Only the root changes: this path now describes a slot containing 11.
  const used = MerkleTree.fromLeaves([11n]);
  await expectNoWitness(compiled, { ...input, oldRoot: used.root });
});

for (const changed of ["sibling", "oldRoot", "index"] as const) {
  test(`merkle: enabled MerkleAppend(32) rejects a wrong ${changed}`, async () => {
    const compiled = await library("merkle", "MerkleAppend", "32");
    const tree = MerkleTree.fromLeaves([11n, 22n]);
    const input = { enabled: 1n, oldRoot: tree.root, index: tree.size, leaf: 66n, siblings: tree.path(tree.size).siblings };
    assert.equal(await checkWitness(compiled, await witness(compiled, input)), true);
    if (changed === "sibling") input.siblings[0] = (input.siblings[0]! + 1n) % fieldPrime;
    if (changed === "oldRoot") input.oldRoot = (input.oldRoot + 1n) % fieldPrime;
    if (changed === "index") input.index = 2 ** 32;
    await expectNoWitness(compiled, input);
  });
}

test("merkle: disabled MerkleAppend(32) preserves oldRoot for arbitrary unused path inputs", async () => {
  const compiled = await library("merkle", "MerkleAppend", "32");
  for (const index of [0n, 1n << 32n, fieldPrime - 1n]) {
    const values = await witness(compiled, {
      enabled: 0n, oldRoot: 123n, index, leaf: fieldPrime - 1n,
      siblings: Array.from({ length: 32 }, (_, i) => fieldPrime - BigInt(i + 1)),
    });
    assert.equal(values[1], 123n);
    assert.equal(await checkWitness(compiled, values), true);
    values[1] = 124n;
    assert.equal(await checkWitness(compiled, values), false);
  }
});

test("merkle: MerkleAppend(32) rejects a non-boolean enabled signal", async () => {
  const compiled = await library("merkle", "MerkleAppend", "32");
  const tree = MerkleTree.empty();
  const input = { enabled: 1n, oldRoot: tree.root, index: 0, leaf: 66n, siblings: tree.path(0).siblings };
  assert.equal(await checkWitness(compiled, await witness(compiled, input)), true);
  await expectNoWitness(compiled, { ...input, enabled: 2n });
});
