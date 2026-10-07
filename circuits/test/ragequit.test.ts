import assert from "node:assert/strict";
import { test } from "node:test";
import { commitment, MerkleTree, nullifierHash, R } from "@zx402/crypto";
import type { Note } from "@zx402/crypto";
import { ragequitWitness } from "@zx402/crypto/witness/ragequit";
import {
  checkWitness,
  compileCircuit,
  constraintCount,
  expectNoWitness,
  witness,
} from "./harness.js";

let compilation: ReturnType<typeof compileCircuit> | undefined;
function circuit() {
  return compilation ??= compileCircuit("circuits/src/main/ragequit.circom");
}

function fixture(value = 42_000_000n) {
  // These fixed test values never belong to a funded note.
  const note: Note = { value, label: 91n, nullifier: 101n, secret: 202n };
  const stateIndex = 3;
  const stateTree = MerkleTree.fromLeaves([11n, 22n, 33n, commitment(note), 44n, 55n]);
  return { note, stateTree, stateIndex };
}

for (const value of [42_000_000n, 0n]) {
  test(`CIR-R00: value ${value} satisfies R1CS with the specified public signal order`, async () => {
    const args = fixture(value);
    const built = ragequitWitness(args);
    const compiled = await circuit();
    const values = await witness(compiled, built.input);
    assert.equal(await checkWitness(compiled, values), true);
    assert.deepEqual(built.publicInputs, [nullifierHash(args.note.nullifier), args.stateTree.root, value, args.note.label]);
    assert.deepEqual(values.slice(1, 5), built.publicInputs);
    assert.equal(built.nullifierHash, values[1]);
    assert.equal(built.stateRoot, values[2]);
  });
}

for (const [name, field, delta] of [
  ["value plus one", "value", 1n],
  ["value minus one", "value", -1n],
  ["label plus one", "label", 1n],
] as const) {
  test(`CIR-R01: ${name} has no witness`, async () => {
    const { input } = ragequitWitness(fixture());
    await expectNoWitness(await circuit(), { ...input, [field]: (BigInt(input[field] as string) + delta).toString() });
  });
}

test("CIR-R02: a wrong sibling has no witness", async () => {
  const { input } = ragequitWitness(fixture());
  const siblings = [...input.siblings as string[]];
  siblings[0] = ((BigInt(siblings[0]!) + 1n) % R).toString();
  await expectNoWitness(await circuit(), { ...input, siblings });
});

for (const [name, index] of [["wrong index", 2], ["index of 2^32", 2 ** 32]] as const) {
  test(`CIR-R02: ${name} has no witness`, async () => {
    const { input } = ragequitWitness(fixture());
    await expectNoWitness(await circuit(), { ...input, index: index.toString() });
  });
}

test("CIR-R02: a wrong stateRoot has no witness", async () => {
  const built = ragequitWitness(fixture());
  await expectNoWitness(await circuit(), { ...built.input, stateRoot: ((built.stateRoot + 1n) % R).toString() });
});

test("CIR-R03: changing the nullifierHash output fails the R1CS check", async () => {
  const compiled = await circuit();
  const values = await witness(compiled, ragequitWitness(fixture()).input);
  assert.equal(await checkWitness(compiled, values), true);
  values[1] = (values[1]! + 1n) % R;
  assert.equal(await checkWitness(compiled, values), false);
});

for (const field of ["nullifier", "secret"] as const) {
  test(`CIR-R03: changing ${field} by one has no witness`, async () => {
    const { input } = ragequitWitness(fixture());
    await expectNoWitness(await circuit(), { ...input, [field]: (BigInt(input[field] as string) + 1n).toString() });
  });
}

test("size: ragequit has fewer than 10,000 constraints", async (t) => {
  const compiled = await circuit();
  const count = await constraintCount(compiled);
  t.diagnostic(`ragequit constraints: ${count}; compile time: ${compiled.compileTimeMs.toFixed(2)} ms; cached: ${compiled.cached}`);
  assert.ok(count < 10_000, `ragequit has ${count} constraints`);
});

test("builder: rejects a note absent from stateIndex", () => {
  const args = fixture();
  assert.throws(() => ragequitWitness({ ...args, stateIndex: 2 }), /stateIndex.*commitment|commitment.*stateIndex/);
});

test("builder: leaves the tree unchanged and returns independent input arrays", () => {
  const args = fixture();
  const before = {
    root: args.stateTree.root,
    size: args.stateTree.size,
    leaves: Array.from({ length: args.stateTree.size }, (_, index) => args.stateTree.leaf(index)),
    path: args.stateTree.path(args.stateIndex),
  };
  const built = ragequitWitness(args);
  (built.input.siblings as string[])[0] = "0";
  built.publicInputs[1] = 0n;
  assert.deepEqual({
    root: args.stateTree.root,
    size: args.stateTree.size,
    leaves: Array.from({ length: args.stateTree.size }, (_, index) => args.stateTree.leaf(index)),
    path: args.stateTree.path(args.stateIndex),
  }, before);
});

for (const field of ["value", "label", "nullifier", "secret"] as const) {
  for (const [name, invalid] of [["negative", -1n], ["field modulus", R]] as const) {
    test(`builder: rejects ${name} ${field} with its name`, () => {
      const args = fixture();
      assert.throws(() => ragequitWitness({ ...args, note: { ...args.note, [field]: invalid } }), new RegExp(field));
    });
  }
}

test("builder: rejects value 2^64", () => {
  const args = fixture();
  assert.throws(() => ragequitWitness({ ...args, note: { ...args.note, value: 1n << 64n } }), /value/);
});

for (const stateIndex of [-1, 1.5, 2 ** 32]) {
  test(`builder: rejects invalid stateIndex ${stateIndex}`, () => {
    assert.throws(() => ragequitWitness({ ...fixture(), stateIndex }), /index/i);
  });
}

test("builder: rejects a noncanonical stateRoot", () => {
  const args = fixture();
  const stateTree = MerkleTree.fromLeaves([11n, 22n, 33n, commitment(args.note), 44n], () => R);
  assert.throws(() => ragequitWitness({ ...args, stateTree }), /stateRoot/);
});

test("builder: rejects a noncanonical sibling", () => {
  const args = fixture();
  const stateTree = MerkleTree.fromLeaves(
    [11n, 22n, 33n, commitment(args.note), 44n],
    (left, right) => left === 11n && right === 22n ? R : 0n,
  );
  assert.throws(() => ragequitWitness({ ...args, stateTree }), /sibling/);
});
