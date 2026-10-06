import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  commitment, insertWitness, MerkleTree, ragequitWitness, spendWitness,
} from "@zbase-cardano/crypto";
import type { InsertSlot, Note } from "@zbase-cardano/crypto";
// The lead links the new workspace after this worker finishes.
import { devKeysPresent, loadDevArtifacts, prove, shutdown, verify } from "@zbase-cardano/prover";
import type { CircuitArtifacts, CircuitName, ProofResult } from "@zbase-cardano/prover";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const provingOptions = {
  skip: devKeysPresent(repoRoot) ? false : "Development proving keys are absent: circuits/build/dev/manifest.json; proving tests require local setup.",
  timeout: 600_000,
};

after(shutdown);

async function timedProof(t: TestContext, circuit: CircuitName, artifacts: CircuitArtifacts, input: Record<string, unknown>) {
  const started = performance.now();
  const result = await prove(artifacts, input);
  t.diagnostic(`${circuit}: prove, self-verification, and compression took ${((performance.now() - started) / 1000).toFixed(3)} s`);
  return result;
}

function spendFixture(withdrawn: bigint) {
  // Fixed fixtures never belong to a funded note.
  const note: Note = { value: 42_000_000n, label: 91n, nullifier: 101n, secret: 202n };
  return spendWitness({
    note, stateTree: MerkleTree.fromLeaves([11n, 22n, commitment(note), 44n]), stateIndex: 2,
    aspTree: MerkleTree.fromLeaves([7n, note.label, 8n]), aspIndex: 1,
    withdrawn, newNullifier: 303n, newSecret: 404n, context: 505n,
  });
}

describe("spend proofs", provingOptions, () => {
  let artifacts: CircuitArtifacts;
  before(async () => { artifacts = await loadDevArtifacts("spend", repoRoot); });
  for (const [name, withdrawn] of [["partial", 12_000_000n], ["full", 42_000_000n]] as const) {
    test(`CIR-S00: a ${name} spend proves with the expected public signals`, async (t) => {
      const built = spendFixture(withdrawn);
      const result = await timedProof(t, "spend", artifacts, built.input);
      assert.deepEqual(result.publicSignals, built.publicInputs);
      assert.equal(await verify(artifacts.vkey, result.publicSignals, result.proof), true);
      for (const [id, signal, index] of [
        ["CIR-S10", "context", 5], ["CIR-S05", "nullifierHash", 1], ["CIR-S08", "newCommitment", 0],
      ] as const) {
        await t.test(`${id}: rejects a changed ${signal} for a ${name} spend`, async () => {
          const changed = [...result.publicSignals];
          changed[index] = changed[index]! + 1n;
          assert.equal(await verify(artifacts.vkey, changed, result.proof), false);
        });
      }
    });
  }
});

describe("insert proofs", provingOptions, () => {
  let artifacts: CircuitArtifacts;
  before(async () => { artifacts = await loadDevArtifacts("insert", repoRoot); });
  const notes: InsertSlot[] = [101n, 102n, 103n, 104n].map((value) => ({ kind: "note", commitment: value }));
  const deposits: InsertSlot[] = [1n, 2n, 3n, 4n].map((value) => ({
    kind: "deposit", value: value * 1_000_000n, label: 31n + value, precommitment: 41n + value,
  }));
  const batches: Array<[string, InsertSlot[]]> = [
    ["1 note", notes.slice(0, 1)], ["4 notes", notes],
    ["1 deposit", deposits.slice(0, 1)], ["4 deposits", deposits],
    ["2 notes then 2 deposits", [...notes.slice(0, 2), ...deposits.slice(0, 2)]],
  ];
  for (const [name, slots] of batches) {
    test(`CIR-I00: ${name} proves with the expected public signals`, async (t) => {
      const built = insertWitness({ tree: MerkleTree.fromLeaves([11n, 22n, 33n]), slots });
      const result = await timedProof(t, "insert", artifacts, built.input);
      assert.deepEqual(result.publicSignals, built.publicInputs);
      assert.equal(await verify(artifacts.vkey, result.publicSignals, result.proof), true);
      for (const [signal, index] of [["newRoot", 1], ["oldRoot", 0], ["startIndex", 2], ["slot x0", 5]] as const) {
        await t.test(`CIR-I08: ${name} rejects a changed ${signal}`, async () => {
          const changed = [...result.publicSignals];
          changed[index] = changed[index]! + 1n;
          assert.equal(await verify(artifacts.vkey, changed, result.proof), false);
        });
      }
    });
  }
});

describe("ragequit proofs", provingOptions, () => {
  let artifacts: CircuitArtifacts;
  before(async () => { artifacts = await loadDevArtifacts("ragequit", repoRoot); });
  test("CIR-R00: a ragequit proves with the expected public signals", async (t) => {
    const note: Note = { value: 42_000_000n, label: 91n, nullifier: 101n, secret: 202n };
    const built = ragequitWitness({
      note, stateTree: MerkleTree.fromLeaves([11n, 22n, commitment(note), 44n]), stateIndex: 2,
    });
    const result: ProofResult = await timedProof(t, "ragequit", artifacts, built.input);
    assert.deepEqual(result.publicSignals, built.publicInputs);
    assert.equal(await verify(artifacts.vkey, result.publicSignals, result.proof), true);
    for (const [signal, index] of [["value", 2], ["label", 3]] as const) {
      await t.test(`CIR-R01: rejects a changed ${signal}`, async () => {
        const changed = [...result.publicSignals];
        changed[index] = changed[index]! + 1n;
        assert.equal(await verify(artifacts.vkey, changed, result.proof), false);
      });
    }
  });
});
