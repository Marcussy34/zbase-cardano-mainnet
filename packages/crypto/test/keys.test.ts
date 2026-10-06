import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bytesToHex, hexToBytes, isCanonical } from "../src/field.js";
import { deriveNoteSecrets, deriveOneTimeKey } from "../src/keys.js";

const vectors = JSON.parse(readFileSync(
  new URL("../../../docs/vectors/key-vectors.json", import.meta.url), "utf8",
)) as {
  cases: { seed: string; index: number; nullifier: string; secret: string; oneTimeKey: string }[];
};

for (const [caseIndex, vector] of vectors.cases.entries()) {
  test(`CRY-09 key vector ${caseIndex + 1} matches all known answers`, () => {
    const seed = hexToBytes(vector.seed);
    const before = seed.slice();
    const note = deriveNoteSecrets(seed, vector.index);
    assert.deepEqual(note, { nullifier: BigInt(vector.nullifier), secret: BigInt(vector.secret) });
    assert.ok(isCanonical(note.nullifier));
    assert.ok(isCanonical(note.secret));
    assert.notEqual(note.nullifier, note.secret);
    assert.deepEqual(deriveNoteSecrets(seed, vector.index), note);
    const key = deriveOneTimeKey(seed, vector.index);
    assert.equal(key.length, 32);
    assert.equal(bytesToHex(key), vector.oneTimeKey);
    assert.deepEqual(deriveOneTimeKey(seed, vector.index), key);
    assert.deepEqual(seed, before);
  });
}

test("CRY-09 indexes zero and one give distinct secrets and one-time keys", () => {
  for (const seedHex of new Set(vectors.cases.map((vector) => vector.seed))) {
    const seed = hexToBytes(seedHex);
    const zero = deriveNoteSecrets(seed, 0);
    const one = deriveNoteSecrets(seed, 1);
    assert.notEqual(zero.nullifier, one.nullifier);
    assert.notEqual(zero.secret, one.secret);
    assert.notDeepEqual(deriveOneTimeKey(seed, 0), deriveOneTimeKey(seed, 1));
  }
});

test("CRY-09 derivation accepts the largest safe integer index", () => {
  const seed = hexToBytes(vectors.cases[0]!.seed);
  const index = Number.MAX_SAFE_INTEGER;
  const note = deriveNoteSecrets(seed, index);
  assert.ok(isCanonical(note.nullifier));
  assert.ok(isCanonical(note.secret));
  assert.deepEqual(deriveNoteSecrets(seed, index), note);
  assert.equal(deriveOneTimeKey(seed, index).length, 32);
});

for (const derive of [deriveNoteSecrets, deriveOneTimeKey]) {
  for (const size of [0, 31, 33]) {
    test(`CRY-10 ${derive.name} rejects seed length ${size}`, () => {
      assert.throws(() => derive(new Uint8Array(size), 0), { name: "RangeError", message: /seed/ });
    });
  }
  for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    test(`CRY-10 ${derive.name} rejects index ${index}`, () => {
      assert.throws(() => derive(hexToBytes(vectors.cases[0]!.seed), index), {
        name: "RangeError", message: /index/,
      });
    });
  }
}
