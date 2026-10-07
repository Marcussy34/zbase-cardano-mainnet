import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { readBinFile, readSection } from "@iden3/binfileutils";
import { curves, powersOfTau, zKey } from "snarkjs";
import { buildDir, circuitInfo, circuitNames, repoRoot, sha256 } from "./public-signals.mjs";

const started = performance.now();
const timings = { steps: {}, stage_sha256: {} };
const logger = { log() {}, info() {}, debug() {}, warn: console.warn, error: console.error };
let curve;
let outputDir = join(buildDir, "dev");
let force = false;

async function timed(name, action) {
  console.log(`${name}: starting`);
  const start = performance.now();
  const result = await action();
  timings.steps[name] = Number(((performance.now() - start) / 1000).toFixed(3));
  console.log(`${name}: ${timings.steps[name].toFixed(3)} s`);
  return result;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJson(path, data) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

async function matches(path, expected) {
  return typeof expected === "string" && existsSync(path) && await sha256(path) === expected;
}

async function getCurve() {
  curve ??= await curves.getCurveFromName("bls12-381");
  return curve;
}

async function isPreparedPtau(path, power) {
  const { fd, sections } = await readBinFile(path, "ptau", 1);
  try {
    if (![12, 13, 14, 15].every((section) => sections[section]?.length === 1)) return false;
    const header = Buffer.from(await readSection(fd, sections, 1));
    const fieldBytes = header.readUInt32LE(0);
    if (fieldBytes !== 48 || header.length !== fieldBytes + 12) return false;
    const prime = BigInt(`0x${Buffer.from(header.subarray(4, 4 + fieldBytes)).reverse().toString("hex")}`);
    return header.readUInt32LE(4 + fieldBytes) === power && prime === (await getCurve()).q;
  } finally {
    await fd.close();
  }
}

async function main() {
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === "--force") force = true;
    else if (arg === "--out-dir" && process.argv[i + 1]) outputDir = resolve(repoRoot, process.argv[++i]);
    else throw new Error("Usage: node circuits/scripts/setup-dev.mjs [--force] [--out-dir circuits/build/<directory>]");
  }
  const outputRelative = relative(buildDir, outputDir);
  if (!outputRelative || outputRelative.startsWith("..") || isAbsolute(outputRelative)) {
    throw new Error("Development keys must stay in a subdirectory of circuits/build");
  }
  console.warn("CAUTION: Development keys are for tests only and must never guard funds.");
  await mkdir(outputDir, { recursive: true });
  await timed("build", async () => {
    if (circuitNames.some((name) => !existsSync(join(buildDir, `${name}.r1cs`)) || !existsSync(join(buildDir, `${name}_js/${name}.wasm`)))) {
      execFileSync("bash", [join(repoRoot, "circuits/scripts/build.sh")], { cwd: repoRoot, stdio: "inherit" });
    }
  });

  const toolchain = {
    circom: execFileSync(join(repoRoot, "node_modules/.bin/circom2"), ["--version"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    snarkjs: JSON.parse(await readFile(join(repoRoot, "node_modules/snarkjs/package.json"), "utf8")).version,
    node: process.version,
  };
  const inputs = {};
  await timed("circuit hashes and capacity", async () => {
    for (const name of circuitNames) {
      const info = await circuitInfo(name);
      // snarkjs adds one row per public signal, plus the constant wire.
      const required = info.constraints + info.outputs + info.publicInputs + 1;
      inputs[name] = {
        r1cs_sha256: await sha256(join(buildDir, `${name}.r1cs`)),
        wasm_sha256: await sha256(join(buildDir, `${name}_js/${name}.wasm`)),
        constraints: info.constraints,
        power: Math.ceil(Math.log2(required)),
      };
      console.log(`${name}: ${info.constraints} constraints, ${required} rows, minimum power ${inputs[name].power}`);
    }
  });
  const power = Math.max(...Object.values(inputs).map((input) => input.power));
  console.log(`Shared powers of tau: bls12-381, power ${power}, capacity ${2 ** power}`);
  const manifestPath = join(outputDir, "manifest.json");
  const previous = await readJson(manifestPath);
  const ptau = join(outputDir, `pot${power}_final.ptau`);
  const receiptPath = join(outputDir, "phase1-verified.json");
  const receipt = await readJson(receiptPath);
  let phase1Valid = false;

  if (!force && existsSync(ptau)) {
    // Rehash a previously verified file instead of repeating expensive pairings on every test run.
    phase1Valid = await timed("phase1 cache validation", async () =>
      receipt?.power === power && receipt?.snarkjs === toolchain.snarkjs && receipt?.verified === true && await matches(ptau, receipt.sha256));
    if (!phase1Valid) {
      // snarkjs verify accepts an unprepared transcript, so check the phase2 sections separately.
      phase1Valid = await timed("phase1 verify existing", async () =>
        await isPreparedPtau(ptau, power) && await powersOfTau.verify(ptau, logger));
    }
  }
  if (!phase1Valid) {
    const initial = join(outputDir, `pot${power}_0000.ptau`);
    const contributed = join(outputDir, `pot${power}_0001.ptau`);
    const prepared = `${ptau}.tmp`;
    await timed("phase1 initialize", async () => powersOfTau.newAccumulator(await getCurve(), power, initial, logger));
    timings.stage_sha256.phase1_initial = await sha256(initial);
    await timed("phase1 contribute", () => powersOfTau.contribute(initial, contributed, "zx402 development phase1", "zbase-dev-phase1-fixed-entropy-v1", logger));
    timings.stage_sha256.phase1_contributed = await sha256(contributed);
    await timed("phase1 prepare phase2", () => powersOfTau.preparePhase2(contributed, prepared, logger));
    if (!await timed("phase1 verify", () => powersOfTau.verify(prepared, logger))) throw new Error("Development powers of tau failed verification");
    await rename(prepared, ptau);
    await rm(initial);
    await rm(contributed);
  }
  const phase1Hash = await timed("phase1 hash", () => sha256(ptau));
  await writeJson(receiptPath, { power, snarkjs: toolchain.snarkjs, verified: true, sha256: phase1Hash });
  const manifest = {
    version: "dev",
    phase1: { file: `pot${power}_final.ptau`, sha256: phase1Hash, power },
    circuits: {},
    toolchain,
  };
  for (const name of circuitNames) {
    const keyPath = join(outputDir, `${name}.zkey`);
    const vkeyPath = join(outputDir, `${name}_vkey.json`);
    const cached = previous?.circuits?.[name];
    const input = inputs[name];
    const reusable = !force && previous?.version === "dev" && previous?.phase1?.sha256 === phase1Hash
      && JSON.stringify(previous?.toolchain) === JSON.stringify(toolchain)
      && cached?.r1cs_sha256 === input.r1cs_sha256 && cached?.wasm_sha256 === input.wasm_sha256
      && await timed(`${name} cache validation`, async () => await matches(keyPath, cached.zkey_sha256) && await matches(vkeyPath, cached.vkey_sha256));
    if (reusable) {
      manifest.circuits[name] = cached;
      console.log(`${name}: reusing verified development key`);
    } else {
      await getCurve();
      const initial = join(outputDir, `${name}_0000.zkey`);
      const contributed = `${keyPath}.tmp`;
      const created = await timed(`${name} groth16 setup`, () => zKey.newZKey(join(buildDir, `${name}.r1cs`), ptau, initial, logger));
      if (created === -1) throw new Error(`${name}: Groth16 setup failed`);
      timings.stage_sha256[`${name}_initial`] = await sha256(initial);
      await timed(`${name} contribute`, () => zKey.contribute(initial, contributed, `zx402 development ${name}`, `zbase-dev-${name}-fixed-entropy-v1`, logger));
      // The initial key was just built from this R1CS. Reuse it instead of repeating Groth16 setup during verification.
      // snarkjs leaves its verification ptau handle open. An in-memory input avoids that file descriptor leak.
      if (!await timed(`${name} verify`, async () => zKey.verifyFromInit(initial, await readFile(ptau), contributed, logger))) {
        throw new Error(`${name}: development key failed verification`);
      }
      const vkey = await timed(`${name} export vkey`, () => zKey.exportVerificationKey(contributed, logger));
      await rename(contributed, keyPath);
      await writeJson(vkeyPath, vkey);
      manifest.circuits[name] = {
        ...input,
        zkey_sha256: await sha256(keyPath),
        vkey_sha256: await sha256(vkeyPath),
      };
      await rm(initial);
    }
    console.log(`${name}: ${(await stat(keyPath)).size} bytes, zkey SHA-256 ${manifest.circuits[name].zkey_sha256}`);
    await writeJson(manifestPath, manifest);
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  // snarkjs and ffjavascript share this cached curve. Its workers otherwise keep Node alive.
  if (curve) await timed("terminate curve workers", () => curve.terminate());
  timings.total_seconds = Number(((performance.now() - started) / 1000).toFixed(3));
  console.log(`Total development setup: ${timings.total_seconds.toFixed(3)} s`);
  if (existsSync(outputDir) && !process.exitCode) await writeJson(join(outputDir, "timings.json"), timings);
}
