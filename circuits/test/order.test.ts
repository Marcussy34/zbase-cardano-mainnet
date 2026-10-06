import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { r1cs } from "snarkjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifact = join(root, "artifacts/public-signals.json");
const circuits = ["spend", "insert", "ragequit"] as const;
const curves = new Set<{ terminate(): Promise<void> }>();

before(() => {
  const missing = circuits.some((name) => [
    `${name}.r1cs`, `${name}.sym`, `${name}_js/${name}.wasm`,
  ].some((file) => !existsSync(join(root, "circuits/build", file))));
  if (missing) execFileSync("bash", ["circuits/scripts/build.sh"], { cwd: root, stdio: "inherit" });
});

after(async () => {
  for (const curve of curves) await curve.terminate();
});

test("CIR-O01: public signal orders match SPEC 5.1, 5.2, and 5.3", () => {
  assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), {
    spend: ["newCommitment", "nullifierHash", "withdrawnValue", "stateRoot", "aspRoot", "context"],
    insert: ["oldRoot", "newRoot", "startIndex", "v0", "l0", "x0", "v1", "l1", "x1", "v2", "l2", "x2", "v3", "l3", "x3"],
    ragequit: ["nullifierHash", "stateRoot", "value", "label"],
  });
});

test("CIR-O01: regeneration preserves the tracked artifact bytes", () => {
  const original = readFileSync(artifact);
  execFileSync(process.execPath, ["circuits/scripts/public-signals.mjs"], { cwd: root, stdio: "inherit" });
  assert.deepEqual(readFileSync(artifact), original);
  assert.equal(original.at(-1), 10, "artifact ends with a newline");
});

test("CIR-O01: compiled circuits expose 6, 15, and 4 public signals", async () => {
  const expected = { spend: 6, insert: 15, ragequit: 4 };
  for (const name of circuits) {
    const info = await r1cs.info(join(root, "circuits/build", `${name}.r1cs`));
    curves.add(info.curve);
    assert.equal(info.nOutputs + info.nPubInputs, expected[name], name);
  }
});
