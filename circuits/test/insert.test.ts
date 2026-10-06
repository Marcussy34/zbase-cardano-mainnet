import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { MerkleTree, R, ZERO_HASHES, h3, rootFromPath } from "@zbase-cardano/crypto";
import { INSERT_BATCH, insertWitness, slotLeaf } from "../../packages/crypto/src/witness/insert.js";
import type { InsertCircuitInput, InsertSlot } from "../../packages/crypto/src/witness/insert.js";
import { checkWitness, compileCircuit, constraintCount, expectNoWitness, witness } from "./harness.js";
import type { CompiledCircuit } from "./harness.js";

const notes: InsertSlot[] = [101n, 102n, 103n, 104n].map((commitment) => ({ kind: "note", commitment }));
const deposit = { kind: "deposit", value: 5_000_000n, label: 31n, precommitment: 41n } as const;
const existingLeaves = [11n, 12n, 13n];
const seededTree = () => MerkleTree.fromLeaves(existingLeaves);
let compilation: Promise<CompiledCircuit> | undefined;
const compiled = () => compilation ??= compileCircuit("circuits/src/main/insert.circom");
const rows = (input: InsertCircuitInput, name: "slots" | "siblings") => input[name] as string[][];
const honestInput = (slots: InsertSlot[] = [notes[0]!]) => insertWitness({ tree: seededTree(), slots }).input;

const deposits: InsertSlot[] = [0n, 1n, 2n, 3n].map((i) => ({
  kind: "deposit", value: 5_000_000n + i, label: 31n + i, precommitment: 41n + i,
}));
const validBatches: Array<{ name: string; slots: InsertSlot[]; empty?: boolean }> = [
  { name: "1 note", slots: notes.slice(0, 1) },
  { name: "4 notes", slots: notes },
  { name: "1 deposit", slots: [deposit] },
  { name: "4 deposits", slots: deposits },
  { name: "2 notes then 2 deposits", slots: [...notes.slice(0, 2), ...deposits.slice(0, 2)] },
  { name: "1 note into an empty tree", slots: notes.slice(0, 1), empty: true },
];

for (const { name, slots, empty } of validBatches) {
  test(`CIR-I00: ${name} satisfies the R1CS and public signal order`, async (t) => {
    const tree = empty ? MerkleTree.empty() : seededTree();
    const result = insertWitness({ tree, slots });
    const expected = tree.clone();
    for (const slot of slots) {
      expected.append(slot.kind === "note" ? slot.commitment : h3(slot.value, slot.label, slot.precommitment));
    }
    const circuit = await compiled();
    const start = performance.now();
    const values = await witness(circuit, result.input);
    t.diagnostic(`witness generation: ${(performance.now() - start).toFixed(2)} ms`);
    assert.equal(await checkWitness(circuit, values), true);
    assert.deepEqual(values.slice(1, 16), result.publicInputs);
    assert.equal(result.publicInputs.length, 15);
    assert.equal(result.startIndex, empty ? 0 : 3);
    assert.equal(result.newRoot, expected.root);
  });
}

test("CIR-I01: rejects a gap between used slots", async () => {
  const input = honestInput(notes.slice(0, 2));
  rows(input, "slots")[2] = rows(input, "slots")[1]!;
  rows(input, "slots")[1] = ["0", "0", "0"];
  rows(input, "siblings")[2] = rows(input, "siblings")[1]!;
  rows(input, "siblings")[1] = Array<string>(32).fill("0");
  await expectNoWitness(await compiled(), input);
});

test("CIR-I01: rejects an empty slot 0 followed by a used slot", async () => {
  const input = honestInput();
  rows(input, "slots")[1] = rows(input, "slots")[0]!;
  rows(input, "slots")[0] = ["0", "0", "0"];
  rows(input, "siblings")[1] = rows(input, "siblings")[0]!;
  rows(input, "siblings")[0] = Array<string>(32).fill("0");
  await expectNoWitness(await compiled(), input);
});

test("CIR-I01: rejects all empty slots", async () => {
  const input = honestInput();
  rows(input, "slots")[0] = ["0", "0", "0"];
  input.newRoot = input.oldRoot!;
  await expectNoWitness(await compiled(), input);
});

for (const [column, value, name] of [[0, "5", "value"], [1, "7", "label"]] as const) {
  test(`CIR-I02: rejects an empty slot with a nonzero ${name}`, async () => {
    const input = honestInput();
    rows(input, "slots")[1]![column] = value;
    await expectNoWitness(await compiled(), input);
  });
}

test("CIR-I03: rejects a note slot with value 5", async () => {
  const input = honestInput();
  rows(input, "slots")[0]![0] = "5";
  await expectNoWitness(await compiled(), input);
});

test("CIR-I04: rejects a deposit value of 2^64 even with its matching root", async () => {
  const input = honestInput([deposit]);
  rows(input, "slots")[0]![0] = String(1n << 64n);
  const expected = seededTree();
  expected.append(h3(1n << 64n, deposit.label, deposit.precommitment));
  input.newRoot = String(expected.root);
  await expectNoWitness(await compiled(), input);
});

for (const [name, leaf] of [
  ["precommitment instead of H3", deposit.precommitment],
  ["H3 with value + 1", h3(deposit.value + 1n, deposit.label, deposit.precommitment)],
] as const) {
  test(`CIR-I05: rejects a deposit root computed with ${name}`, async () => {
    const input = honestInput([deposit]);
    const wrongTree = seededTree();
    wrongTree.append(leaf);
    input.newRoot = String(wrongTree.root);
    await expectNoWitness(await compiled(), input);
  });
}

test("CIR-I06: rejects replacing an occupied leaf using its real path", async () => {
  const tree = seededTree();
  const input = honestInput();
  input.startIndex = "1";
  rows(input, "siblings")[0] = tree.path(1).siblings.map(String);
  tree.set(1, 101n);
  input.newRoot = String(tree.root);
  await expectNoWitness(await compiled(), input);
});

for (const [name, index] of [["startIndex + 1", 4], ["startIndex - 1", 2], ["2^32", 2 ** 32]] as const) {
  test(`CIR-I07: rejects ${name} with the honest siblings`, async () => {
    const input = honestInput();
    input.startIndex = String(index);
    await expectNoWitness(await compiled(), input);
  });
}

for (const name of ["newRoot", "oldRoot"] as const) {
  test(`CIR-I08: rejects ${name} + 1`, async () => {
    const input = honestInput();
    input[name] = String((BigInt(input[name] as string) + 1n) % R);
    await expectNoWitness(await compiled(), input);
  });
}

test("CIR-I08: changing newRoot after witness generation fails the R1CS check", async () => {
  const circuit = await compiled();
  const values = await witness(circuit, honestInput());
  assert.equal(await checkWitness(circuit, values), true);
  values[2] = (values[2]! + 1n) % R;
  assert.equal(await checkWitness(circuit, values), false);
});

test("order: slot i lands at startIndex + i in caller order", async () => {
  const slots = [deposits[0]!, notes[0]!, deposits[1]!, notes[1]!];
  const result = insertWitness({ tree: seededTree(), slots });
  const expectedLeaves = [h3(5_000_000n, 31n, 41n), 101n, h3(5_000_001n, 32n, 42n), 102n];
  for (const [i, leaf] of expectedLeaves.entries()) {
    assert.equal(result.tree.leaf(result.startIndex + i), leaf);
  }
  const circuit = await compiled();
  assert.equal(await checkWitness(circuit, await witness(circuit, result.input)), true);
});

test("unused: arbitrary siblings of unused slots leave the new root unchanged", async () => {
  const result = insertWitness({ tree: seededTree(), slots: notes.slice(0, 1) });
  for (let i = 1; i < INSERT_BATCH; i += 1) {
    rows(result.input, "siblings")[i] = Array.from({ length: 32 }, () =>
      BigInt(`0x${randomBytes(31).toString("hex")}`).toString());
  }
  const circuit = await compiled();
  const values = await witness(circuit, result.input);
  assert.equal(await checkWitness(circuit, values), true);
  assert.equal(values[2], result.newRoot);
});

test("unused: a final-capacity append keeps unused indexes in range", async () => {
  const index = 2 ** 32 - 1;
  const siblings = ZERO_HASHES.slice(0, 32);
  const input = honestInput();
  input.startIndex = String(index);
  input.oldRoot = String(rootFromPath(0n, index, siblings));
  input.newRoot = String(rootFromPath(101n, index, siblings));
  rows(input, "siblings")[0] = siblings.map(String);
  const circuit = await compiled();
  const values = await witness(circuit, input);
  assert.equal(await checkWitness(circuit, values), true);
  assert.equal(values[2], BigInt(input.newRoot));
});

test("size: insert uses fewer than 70000 constraints", async (t) => {
  const circuit = await compiled();
  const count = await constraintCount(circuit);
  t.diagnostic(`constraints: ${count}; compile: ${circuit.compileTimeMs.toFixed(2)} ms; cached: ${circuit.cached}`);
  assert.ok(count < 70_000, `insert has ${count} constraints`);
});

test("builder: appends ordered leaves and leaves the argument tree unchanged", () => {
  const tree = seededTree();
  const oldRoot = tree.root;
  const slots = [notes[0]!, deposit];
  const expectedLeaves = [101n, h3(5_000_000n, 31n, 41n)];
  const result = insertWitness({ tree, slots });
  assert.equal(INSERT_BATCH, 4);
  assert.deepEqual(result.leaves, expectedLeaves);
  assert.equal(result.oldRoot, oldRoot);
  assert.equal(result.startIndex, 3);
  assert.equal(result.newRoot, MerkleTree.fromLeaves([...existingLeaves, ...expectedLeaves]).root);
  assert.equal(result.tree.root, result.newRoot);
  assert.deepEqual(result.publicInputs, [oldRoot, result.newRoot, 3n, 0n, 0n, 101n,
    5_000_000n, 31n, 41n, 0n, 0n, 0n, 0n, 0n, 0n]);
  assert.deepEqual(result.input.slots, [["0", "0", "101"], ["5000000", "31", "41"],
    ["0", "0", "0"], ["0", "0", "0"]]);
  assert.deepEqual((result.input.siblings as string[][]).slice(2),
    Array.from({ length: 2 }, () => Array<string>(32).fill("0")));
  assert.notEqual(result.tree, tree);
  assert.equal(tree.size, 3);
  assert.equal(tree.root, oldRoot);
  assert.deepEqual(existingLeaves.map((_, i) => tree.leaf(i)), existingLeaves);
  assert.equal(tree.leaf(3), 0n);
  result.tree.set(0, 99n);
  assert.equal(tree.leaf(0), 11n);
});

test("builder: slotLeaf uses the note commitment and the deposit H3", () => {
  assert.equal(slotLeaf(notes[0]!), 101n);
  assert.equal(slotLeaf(deposit), h3(5_000_000n, 31n, 41n));
});

test("builder: deposit values include both unsigned 64-bit boundaries", () => {
  for (const value of [0n, (1n << 64n) - 1n]) {
    const result = insertWitness({ tree: seededTree(), slots: [{ ...deposit, value }] });
    assert.equal(result.leaves[0], h3(value, 31n, 41n));
  }
});

const invalidBatches: Array<{ name: string; slots: InsertSlot[]; error: RegExp }> = [
  { name: "zero slots", slots: [], error: /slots/i },
  { name: "more than four slots", slots: [...notes, notes[0]!], error: /slots/i },
  { name: "zero note commitment", slots: [{ kind: "note", commitment: 0n }], error: /commitment/i },
  { name: "zero deposit label", slots: [{ ...deposit, label: 0n }], error: /label/i },
  { name: "zero deposit precommitment", slots: [{ ...deposit, precommitment: 0n }], error: /precommitment/i },
  { name: "negative deposit value", slots: [{ ...deposit, value: -1n }], error: /value/i },
  { name: "deposit value at 2^64", slots: [{ ...deposit, value: 1n << 64n }], error: /value/i },
];
for (const value of [-1n, R]) {
  invalidBatches.push(
    { name: `noncanonical note commitment ${value}`, slots: [{ kind: "note", commitment: value }], error: /commitment/i },
    { name: `noncanonical deposit label ${value}`, slots: [{ ...deposit, label: value }], error: /label/i },
    { name: `noncanonical deposit precommitment ${value}`, slots: [{ ...deposit, precommitment: value }], error: /precommitment/i },
  );
}
invalidBatches.push({ name: "noncanonical deposit value", slots: [{ ...deposit, value: R }], error: /value/i });
for (const { name, slots, error } of invalidBatches) {
  test(`builder: rejects ${name}`, () => {
    assert.throws(() => insertWitness({ tree: seededTree(), slots }), error);
  });
}

for (const remaining of [0, 1]) {
  test(`builder: rejects a batch when the tree has ${remaining} spaces left`, () => {
    const tree = seededTree();
    // Capacity is checked before any append, so no huge tree fixture is needed.
    Object.defineProperty(tree, "size", { value: 2 ** 32 - remaining });
    assert.throws(() => insertWitness({ tree, slots: notes.slice(0, remaining + 1) }), /room|full|capacity/i);
  });
}
