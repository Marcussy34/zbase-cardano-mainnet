import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { commitment, MerkleTree, R, ragequitWitness } from "@zbase-cardano/crypto";
import type { Note } from "@zbase-cardano/crypto";
import {
  devKeysPresent, loadArtifacts, loadDevArtifacts, loadDevVkey, prove, shutdown, verify,
} from "../src/index.js";
import type { CircuitArtifacts, CircuitManifest, ProofResult } from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const missingKeys = "Development proving keys are absent: circuits/build/dev/manifest.json; proving tests require local setup.";
const provingOptions = { skip: devKeysPresent(repoRoot) ? false : missingKeys, timeout: 600_000 };

function witness(value = 42_000_000n) {
  // Fixed fixtures never belong to a funded note.
  const note: Note = { value, label: 91n, nullifier: 101n, secret: 202n };
  return ragequitWitness({
    note, stateIndex: 1, stateTree: MerkleTree.fromLeaves([11n, commitment(note), 33n]),
  });
}

after(shutdown);

test("CIR-R00: committed verification keys load without proving keys", async () => {
  for (const circuit of ["spend", "insert", "ragequit"] as const) {
    const expected = JSON.parse(await readFile(join(repoRoot, "artifacts/dev", `${circuit}_vkey.json`), "utf8"));
    assert.deepEqual(await loadDevVkey(circuit, repoRoot), expected);
  }
});

test("CIR-R00: missing development keys name both recovery commands", async () => {
  const absentRoot = join(repoRoot, "packages/prover/build/absent-repository");
  assert.equal(devKeysPresent(absentRoot), false);
  await assert.rejects(loadDevArtifacts("ragequit", absentRoot), (error: Error) => {
    assert.match(error.message, /npm run build:circuits/);
    assert.match(error.message, /npm run setup:dev/);
    return true;
  });
});

describe("CIR-R00: checked development artifacts", provingOptions, () => {
  const paths = {
    circuit: "ragequit" as const,
    wasmPath: join(repoRoot, "circuits/build/ragequit_js/ragequit.wasm"),
    zkeyPath: join(repoRoot, "circuits/build/dev/ragequit.zkey"),
    vkeyPath: join(repoRoot, "circuits/build/dev/ragequit_vkey.json"),
  };
  let manifest: CircuitManifest;
  before(async () => {
    manifest = JSON.parse(await readFile(join(repoRoot, "circuits/build/dev/manifest.json"), "utf8")).circuits;
  });

  test("CIR-R00: matching hashes load the local ragequit artifacts", async () => {
    const artifacts = await loadDevArtifacts("ragequit", repoRoot);
    assert.deepEqual(artifacts.vkey, await loadDevVkey("ragequit", repoRoot));
    assert.ok(artifacts.wasm);
    assert.ok(artifacts.zkey);
  });

  test("CIR-R00: a different local verification key identifies another setup run", async (t) => {
    const read = fs.readFile;
    // Change only the bytes returned to this test, leaving the shared key files untouched.
    const mocked = t.mock.method(fs, "readFile", async (...args: Parameters<typeof read>) => {
      const bytes = await read(...args);
      if (args[0] !== paths.vkeyPath) return bytes;
      return typeof bytes === "string" ? `${bytes}\n` : Buffer.concat([bytes, Buffer.from("\n")]);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(loadDevArtifacts("ragequit", repoRoot), /local keys come from another setup run/);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });

  for (const [hash, path] of [
    ["wasm_sha256", "wasmPath"], ["zkey_sha256", "zkeyPath"], ["vkey_sha256", "vkeyPath"],
  ] as const) {
    test(`CIR-R00: rejects an incorrect ${hash} and names its file`, async () => {
      const changed = { ...manifest, ragequit: { ...manifest.ragequit!, [hash]: "0".repeat(64) } };
      await assert.rejects(loadArtifacts({ ...paths, manifest: changed }), (error: Error) => {
        assert.ok(error.message.includes(paths[path]), error.message);
        assert.match(error.message, /SHA-256/i);
        return true;
      });
    });
  }
});

describe("CIR-R00: ragequit proving and verification", provingOptions, () => {
  let artifacts: CircuitArtifacts;
  let result: ProofResult;
  before(async () => {
    artifacts = await loadDevArtifacts("ragequit", repoRoot);
    result = await prove(artifacts, witness().input);
  });

  test("CIR-R00: proof round-trips with ordered bigints and Cardano point sizes", async () => {
    assert.deepEqual(result.publicSignals, witness().publicInputs);
    assert.equal(await verify(artifacts.vkey, result.publicSignals, result.proof), true);
    assert.deepEqual([result.cardano.a.length, result.cardano.b.length, result.cardano.c.length], [48, 96, 48]);
  });

  test("CIR-R01: rejects one changed public signal", async () => {
    const changed = [...result.publicSignals];
    changed[2] = changed[2]! + 1n;
    assert.equal(await verify(artifacts.vkey, changed, result.proof), false);
  });

  test("CIR-R01: rejects a proof made for another input", async () => {
    const other = await prove({
      ...artifacts,
      wasm: join(repoRoot, "circuits/build/ragequit_js/ragequit.wasm"),
      zkey: join(repoRoot, "circuits/build/dev/ragequit.zkey"),
    }, witness(43_000_000n).input);
    assert.equal(await verify(artifacts.vkey, other.publicSignals, other.proof), true);
    assert.equal(await verify(artifacts.vkey, result.publicSignals, other.proof), false);
  });

  test("VER-03: rejects too few or too many public signals", async () => {
    assert.equal(await verify(artifacts.vkey, result.publicSignals.slice(1), result.proof), false);
    assert.equal(await verify(artifacts.vkey, [...result.publicSignals, 0n], result.proof), false);
  });

  test("VER-01: rejects noncanonical signals before snarkjs reads the verification key", async () => {
    let reads = 0;
    const vkey = {
      ...artifacts.vkey,
      get vk_alpha_1() {
        reads += 1;
        return artifacts.vkey.vk_alpha_1;
      },
    };
    // The real verifier reads this coordinate. The range guard must return before it does.
    assert.equal(await verify(vkey, result.publicSignals, result.proof), true);
    assert.ok(reads > 0);
    for (const value of [result.publicSignals[0]! + R, R, -1n]) {
      reads = 0;
      const changed = [...result.publicSignals];
      changed[0] = value;
      assert.equal(await verify(vkey, changed, result.proof), false);
      assert.equal(reads, 0, "snarkjs must not inspect the key for an out-of-range signal");
    }
  });

  test("CIR-R01: proving rejects an input without a valid witness", async () => {
    const valid = witness().input;
    await assert.rejects(prove(artifacts, { ...valid, value: "42000001" }));
  });

  test("CIR-R00: proving refuses to return a proof that fails its own verification", async () => {
    const vkey = { ...artifacts.vkey, vk_alpha_1: artifacts.vkey.IC[0]! };
    await assert.rejects(prove({ ...artifacts, vkey }, witness().input), /verif/i);
  });
});

test("CIR-R00: shutdown is repeatable and a proving process exits naturally", provingOptions, async () => {
  const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
  const script = `
    (async () => {
      const { loadDevArtifacts, prove, shutdown } = await import(${JSON.stringify(moduleUrl)});
      const { commitment, MerkleTree, ragequitWitness } = await import("@zbase-cardano/crypto");
      const note = { value: 42000000n, label: 91n, nullifier: 101n, secret: 202n };
      const built = ragequitWitness({ note, stateTree: MerkleTree.fromLeaves([commitment(note)]), stateIndex: 0 });
      try {
        const artifacts = await loadDevArtifacts("ragequit", ${JSON.stringify(repoRoot)});
        await prove(artifacts, built.input);
      } finally {
        await shutdown();
        await shutdown();
      }
      console.log("shutdown complete");
    })().catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  // An explicit input-type flag is inherited by snarkjs's file-based workers and prevents startup.
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    ["--import", "tsx", "-e", script],
    { cwd: repoRoot, timeout: 600_000, maxBuffer: 1024 * 1024 });
  assert.equal(stdout.trim(), "shutdown complete");
  assert.equal(stderr, "");
});
