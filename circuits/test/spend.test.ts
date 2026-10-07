import assert from "node:assert/strict";
import { before, test } from "node:test";
import { commitment, h1, h2, h3, MerkleTree, R } from "@zx402/crypto";
import type { Note } from "@zx402/crypto";
import { spendWitness } from "@zx402/crypto/witness/spend";
import type { SpendArgs, SpendCircuitInput } from "@zx402/crypto/witness/spend";
import { checkWitness, compileCircuit, constraintCount, expectNoWitness, witness } from "./harness.js";
import type { CompiledCircuit } from "./harness.js";

const MAX_VALUE = (1n << 64n) - 1n;
const note: Note = { value: 1_000n, label: 333n, nullifier: 444n, secret: 555n };

function fixture(overrides: Partial<Note> = {}): SpendArgs {
  const existing = { ...note, ...overrides };
  // Hash directly so adversarial fixtures can contain values the SDK rejects.
  const leaf = h3(existing.value, existing.label, h2(existing.nullifier, existing.secret));
  return {
    note: existing,
    stateTree: MerkleTree.fromLeaves([11n, 22n, leaf, 44n, 55n]),
    stateIndex: 2,
    aspTree: MerkleTree.fromLeaves([111n, 222n, 444n, existing.label, 555n]),
    aspIndex: 3,
    withdrawn: 400n,
    newNullifier: 666n,
    newSecret: 777n,
    context: 888n,
  };
}

function input(a: SpendArgs): SpendCircuitInput {
  return {
    withdrawnValue: a.withdrawn.toString(),
    stateRoot: a.stateTree.root.toString(),
    aspRoot: a.aspTree.root.toString(),
    context: a.context.toString(),
    label: a.note.label.toString(),
    existingValue: a.note.value.toString(),
    existingNullifier: a.note.nullifier.toString(),
    existingSecret: a.note.secret.toString(),
    newNullifier: a.newNullifier.toString(),
    newSecret: a.newSecret.toString(),
    stateSiblings: a.stateTree.path(a.stateIndex).siblings.map(String),
    stateIndex: a.stateIndex.toString(),
    aspSiblings: a.aspTree.path(a.aspIndex).siblings.map(String),
    aspIndex: a.aspIndex.toString(),
  };
}

let compiled: CompiledCircuit;
const valid = fixture();
const validInput = input(valid);
let validWitness: bigint[];

before(async () => {
  compiled = await compileCircuit("circuits/src/main/spend.circom");
  validWitness = await witness(compiled, validInput);
});

for (const [name, withdrawn] of [["partial", 400n], ["full", 1_000n], ["zero", 0n]] as const) {
  test(`CIR-S00: ${name} spend satisfies the R1CS with the specified public signal order`, async () => {
    const a = { ...valid, withdrawn };
    const built = spendWitness(a);
    const values = await witness(compiled, built.input);
    const remaining = a.note.value - withdrawn;
    const expected = [
      h3(remaining, a.note.label, h2(a.newNullifier, a.newSecret)),
      h1(a.note.nullifier), withdrawn, a.stateTree.root, a.aspTree.root, a.context,
    ];
    assert.deepEqual(values.slice(1, 7), expected);
    assert.deepEqual(values.slice(1, 7), built.publicInputs);
    assert.deepEqual(built.public, {
      newCommitment: expected[0], nullifierHash: expected[1], withdrawnValue: withdrawn,
      stateRoot: a.stateTree.root, aspRoot: a.aspTree.root, context: a.context,
    });
    assert.deepEqual(built.changeNote, {
      value: remaining, label: a.note.label, nullifier: a.newNullifier, secret: a.newSecret,
    });
    assert.equal(await checkWitness(compiled, values), true);
  });
}

for (const signal of ["existingValue", "label", "existingNullifier", "existingSecret"]) {
  test(`CIR-S01: changing ${signal} breaks state membership`, async () => {
    await expectNoWitness(compiled, { ...validInput, [signal]: (BigInt(validInput[signal] as string) + 1n).toString() });
  });
}

for (const [id, tree] of [["CIR-S02", "state"], ["CIR-S03", "asp"]] as const) {
  for (const part of ["Siblings", "Index", "Root"] as const) {
    test(`${id}: a wrong ${tree}${part} fails`, async () => {
      const signal = `${tree}${part}`;
      const changed = structuredClone(validInput);
      if (part === "Siblings") {
        const siblings = changed[signal] as string[];
        siblings[0] = (BigInt(siblings[0]!) + 1n).toString();
      } else {
        changed[signal] = (BigInt(changed[signal] as string) + 1n).toString();
      }
      await expectNoWitness(compiled, changed);
    });
  }
  test(`${id}: the ${tree} index cannot exceed 32 bits`, async () => {
    await expectNoWitness(compiled, { ...validInput, [`${tree}Index`]: (1n << 32n).toString() });
  });
}

test("CIR-S04: a real zero-label note cannot use an empty ASP leaf", async () => {
  const a = fixture({ label: 0n });
  a.aspTree = MerkleTree.fromLeaves([111n, 222n, 444n]);
  assert.equal(a.stateTree.leaf(a.stateIndex), commitment(a.note));
  assert.equal(a.aspTree.leaf(a.aspIndex), 0n);
  assert.equal(a.aspIndex, a.aspTree.size);
  await expectNoWitness(compiled, input(a));
});

test("CIR-S05: tampering with nullifierHash fails the R1CS", async () => {
  assert.equal(await checkWitness(compiled, validWitness), true);
  const changed = [...validWitness];
  changed[2] = (changed[2]! + 1n) % R;
  assert.equal(await checkWitness(compiled, changed), false);
});

test("CIR-S06: withdrawing more than the note value fails", async () => {
  await expectNoWitness(compiled, { ...validInput, withdrawnValue: (note.value + 1n).toString() });
});

test("CIR-S07: a maximum 64-bit note can be spent in full", async () => {
  const a = fixture({ value: MAX_VALUE });
  a.withdrawn = MAX_VALUE;
  const built = spendWitness(a);
  const values = await witness(compiled, built.input);
  assert.deepEqual(values.slice(1, 7), built.publicInputs);
  assert.equal(await checkWitness(compiled, values), true);
});

test("CIR-S07: withdrawnValue cannot equal 2^64", async () => {
  const a = fixture({ value: MAX_VALUE });
  a.withdrawn = 1n << 64n;
  await expectNoWitness(compiled, input(a));
});

test("CIR-S07: existingValue cannot equal 2^64 even with real membership", async () => {
  const a = fixture({ value: 1n << 64n });
  // Withdrawing one leaves a valid 64-bit remainder, isolating the existingValue bound.
  a.withdrawn = 1n;
  await expectNoWitness(compiled, input(a));
});

test("CIR-S07: withdrawnValue cannot wrap around the field", async () => {
  // The field subtraction would leave 1001, so remaining's bound alone is insufficient.
  await expectNoWitness(compiled, { ...validInput, withdrawnValue: (R - 1n).toString() });
});

test("CIR-S08: tampering with newCommitment fails the R1CS", async () => {
  const changed = [...validWitness];
  changed[1] = (changed[1]! + 1n) % R;
  assert.equal(await checkWitness(compiled, changed), false);
});

for (const part of ["remaining", "label"] as const) {
  test(`CIR-S08: change commitment preserves the correct ${part}`, () => {
    const remaining = note.value - valid.withdrawn + (part === "remaining" ? 1n : 0n);
    const label = note.label + (part === "label" ? 1n : 0n);
    assert.notEqual(validWitness[1], h3(remaining, label, h2(valid.newNullifier, valid.newSecret)));
  });
}

test("CIR-S09: change must use a different nullifier", async () => {
  await expectNoWitness(compiled, { ...validInput, newNullifier: note.nullifier.toString() });
});

test("CIR-S10: context is public and constrained after witness generation", async () => {
  const changed = { ...validInput, context: (valid.context + 1n).toString() };
  const second = await witness(compiled, changed);
  assert.deepEqual(second.slice(1, 6), validWitness.slice(1, 6));
  assert.equal(validWitness[6], valid.context);
  assert.equal(second[6], valid.context + 1n);
  assert.equal(await checkWitness(compiled, validWitness), true);
  assert.equal(await checkWitness(compiled, second), true);
  const tampered = [...validWitness];
  tampered[6] = valid.context + 1n;
  assert.equal(await checkWitness(compiled, tampered), false);
});

test("size: Spend(32) has fewer than 20000 constraints", async (t) => {
  const count = await constraintCount(compiled);
  t.diagnostic(`Spend(32): ${count} constraints; compile ${compiled.compileTimeMs.toFixed(2)} ms; cached ${compiled.cached}`);
  assert.ok(count < 20_000, `Spend(32) uses ${count} constraints`);
});

test("builder: inputs use decimal strings and preserve the note and both trees", () => {
  const a = fixture();
  const before = {
    note: { ...a.note }, stateRoot: a.stateTree.root, stateSize: a.stateTree.size,
    statePath: a.stateTree.path(a.stateIndex), aspRoot: a.aspTree.root,
    aspSize: a.aspTree.size, aspPath: a.aspTree.path(a.aspIndex),
  };
  const built = spendWitness(a);
  assert.deepEqual(built.input, input(a));
  for (const value of Object.values(built.input)) {
    for (const entry of Array.isArray(value) ? value : [value]) assert.match(entry, /^(0|[1-9][0-9]*)$/);
  }
  assert.deepEqual({
    note: a.note, stateRoot: a.stateTree.root, stateSize: a.stateTree.size,
    statePath: a.stateTree.path(a.stateIndex), aspRoot: a.aspTree.root,
    aspSize: a.aspTree.size, aspPath: a.aspTree.path(a.aspIndex),
  }, before);
});

for (const tree of ["state", "asp"] as const) {
  test(`builder: rejects a wrong ${tree} leaf`, () => {
    const a = fixture();
    a[`${tree}Tree`].set(a[`${tree}Index`], 999n);
    assert.throws(() => spendWitness(a), new RegExp(tree, "i"));
  });
  for (const index of [-1, 0.5, 2 ** 32, Number.NaN]) {
    test(`builder: rejects ${tree}Index ${index}`, () => {
      assert.throws(() => spendWitness({ ...valid, [`${tree}Index`]: index }), new RegExp(`${tree}Index`, "i"));
    });
  }
}

test("builder: rejects label zero", () => {
  assert.throws(() => spendWitness(fixture({ label: 0n })), /label/i);
});

test("builder: rejects a withdrawal above the note value", () => {
  assert.throws(() => spendWitness({ ...valid, withdrawn: note.value + 1n }), /withdrawn/i);
});

test("builder: rejects reuse of the old nullifier", () => {
  assert.throws(() => spendWitness({ ...valid, newNullifier: note.nullifier }), /newNullifier/i);
});

test("builder: rejects a note value of 2^64", () => {
  assert.throws(() => spendWitness(fixture({ value: 1n << 64n })), /value.*64/i);
});

for (const field of ["value", "label", "nullifier", "secret"] as const) {
  for (const [name, bad] of [["negative", -1n], ["field modulus", R], ["non-bigint", 1 as unknown as bigint]] as const) {
    test(`builder: rejects ${name} note.${field}`, () => {
      assert.throws(() => spendWitness({ ...valid, note: { ...note, [field]: bad } }), new RegExp(field, "i"));
    });
  }
}

for (const field of ["withdrawn", "newNullifier", "newSecret", "context"] as const) {
  for (const [name, bad] of [["negative", -1n], ["field modulus", R], ["non-bigint", 1 as unknown as bigint]] as const) {
    test(`builder: rejects ${name} ${field}`, () => {
      assert.throws(() => spendWitness({ ...valid, [field]: bad }), new RegExp(field, "i"));
    });
  }
}

for (const tree of ["state", "asp"] as const) {
  for (const part of ["Root", "Siblings"] as const) {
    for (const [name, bad] of [["negative", -1n], ["field modulus", R]] as const) {
      test(`builder: rejects ${name} ${tree}${part}`, () => {
        const a = fixture();
        const source = a[`${tree}Tree`];
        const leaves = Array.from({ length: source.size }, (_, index) => source.leaf(index));
        const target = part === "Root" ? source.root : h2(leaves[0]!, leaves[1]!);
        // MerkleTree accepts a custom hash, so malformed derived values must also be checked.
        a[`${tree}Tree`] = MerkleTree.fromLeaves(leaves, (left, right) => {
          // Preserve every other node so each negative case changes only one exported value.
          const hash = h2(left === bad ? target : left, right === bad ? target : right);
          return hash === target ? bad : hash;
        });
        const changed = a[`${tree}Tree`];
        if (part === "Root") {
          assert.equal(changed.root, bad);
          assert.deepEqual(changed.path(a[`${tree}Index`]), source.path(a[`${tree}Index`]));
        } else {
          assert.equal(changed.root, source.root);
          const expected = source.path(a[`${tree}Index`]).siblings;
          expected[1] = bad;
          assert.deepEqual(changed.path(a[`${tree}Index`]).siblings, expected);
        }
        assert.throws(() => spendWitness(a), new RegExp(`${tree}${part}`, "i"));
      });
    }
  }
}
