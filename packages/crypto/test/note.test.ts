import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { R } from "../src/field.js";
import {
  VALUE_BITS,
  commitment,
  nullifierHash,
  precommitment,
} from "../src/note.js";
import type { Note } from "../src/note.js";

interface NoteVector {
  value: string;
  label: string;
  nullifier: string;
  secret: string;
  precommitment: string;
  commitment: string;
  nullifierHash: string;
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../docs/vectors/poseidon-vectors.json", import.meta.url),
    "utf8",
  ),
) as { note_example: NoteVector; tree_example_2: { second_note: NoteVector } };

function noteFromVector(vector: NoteVector): Note {
  return {
    value: BigInt(vector.value),
    label: BigInt(vector.label),
    nullifier: BigInt(vector.nullifier),
    secret: BigInt(vector.secret),
  };
}

const example = noteFromVector(vectors.note_example);

for (const [name, vector] of [
  ["first note", vectors.note_example],
  ["second note", vectors.tree_example_2.second_note],
] as const) {
  test(`CRY-03 ${name} matches the precommitment vector`, () => {
    const note = noteFromVector(vector);
    assert.equal(
      precommitment(note.nullifier, note.secret),
      BigInt(vector.precommitment),
    );
  });

  test(`CRY-03 ${name} matches the commitment vector`, () => {
    assert.equal(commitment(noteFromVector(vector)), BigInt(vector.commitment));
  });

  test(`CRY-03 ${name} matches the nullifier hash vector`, () => {
    assert.equal(nullifierHash(BigInt(vector.nullifier)), BigInt(vector.nullifierHash));
  });
}

for (const field of ["value", "label", "nullifier", "secret"] as const) {
  for (const invalid of [-1n, R, R + 1n]) {
    test(`CRY-10 commitment rejects ${field} = ${invalid}`, () => {
      assert.throws(() => commitment({ ...example, [field]: invalid }), RangeError);
    });
  }
}

test("CRY-10 commitment rejects a value of 2^64", () => {
  assert.throws(() => commitment({ ...example, value: 2n ** 64n }), RangeError);
});

test("CRY-03 commitment accepts both unsigned 64-bit value boundaries", () => {
  assert.equal(VALUE_BITS, 64);
  for (const value of [0n, 2n ** 64n - 1n]) {
    const result = commitment({ ...example, value });
    assert.ok(result >= 0n && result < R);
  }
});

for (const invalid of [-1n, R, R + 1n]) {
  test(`CRY-10 precommitment rejects nullifier = ${invalid}`, () => {
    assert.throws(() => precommitment(invalid, example.secret), RangeError);
  });

  test(`CRY-10 precommitment rejects secret = ${invalid}`, () => {
    assert.throws(() => precommitment(example.nullifier, invalid), RangeError);
  });

  test(`CRY-10 nullifierHash rejects nullifier = ${invalid}`, () => {
    assert.throws(() => nullifierHash(invalid), RangeError);
  });
}
