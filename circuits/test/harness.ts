import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { r1cs, wtns } from "snarkjs";
import type { CircuitSignals } from "snarkjs";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const buildDir = join(repoRoot, "circuits/build/test");
const sourceDir = join(repoRoot, "circuits/src");
const curves = new Set<{ terminate(): Promise<void> }>();
const logger = { info() {}, warn() {}, error() {}, debug() {} };

// snarkjs caches its curve workers. Closing them lets node:test exit naturally.
after(async () => {
  for (const curve of curves) await curve.terminate();
});

export interface CompiledCircuit {
  r1cs: string;
  wasm: string;
  compileTimeMs: number;
  cached: boolean;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const groups = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return groups.flat().sort();
}

async function compile(path: string, outDir: string): Promise<CompiledCircuit> {
  await mkdir(outDir, { recursive: true });
  const name = basename(path, ".circom");
  const compiled = { r1cs: join(outDir, `${name}.r1cs`), wasm: join(outDir, `${name}_js/${name}.wasm`) };
  const hash = createHash("sha256").update("bls12381:O2:r1cs:wasm:sym");
  const files = [path, fileURLToPath(import.meta.url), ...await sourceFiles(sourceDir)];
  for (const file of files) hash.update(file).update("\0").update(await readFile(file)).update("\0");
  for (const pkg of ["circom2", "poseidon-bls12381-circom"]) {
    hash.update(await readFile(join(repoRoot, "node_modules", pkg, "package.json")));
  }
  const digest = hash.digest("hex");
  const cachePath = join(outDir, `${name}.compile.json`);
  const cached = await readFile(cachePath, "utf8").then(JSON.parse).catch(() => null) as
    { digest: string; compileTimeMs: number } | null;
  if (cached?.digest === digest && await stat(compiled.r1cs).catch(() => null) && await stat(compiled.wasm).catch(() => null)) {
    return { ...compiled, compileTimeMs: cached.compileTimeMs, cached: true };
  }
  const start = performance.now();
  // The compiler's sandbox resolves a real node_modules only from the repository root.
  const { stdout, stderr } = await run("npx", ["circom2", relative(repoRoot, path), "--prime", "bls12381", "--O2",
    "--r1cs", "--wasm", "--sym", "-l", "node_modules", "-o", relative(repoRoot, outDir)],
  { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024, timeout: 180_000 });
  const compileTimeMs = performance.now() - start;
  await writeFile(join(outDir, `${name}.compile.log`), stdout + stderr);
  await writeFile(cachePath, JSON.stringify({ digest, compileTimeMs }));
  return { ...compiled, compileTimeMs, cached: false };
}

export async function compileTemplate(name: string, mainSource: string): Promise<CompiledCircuit> {
  assert.match(name, /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/);
  await mkdir(buildDir, { recursive: true });
  const path = join(buildDir, `${name}.circom`);
  if (await readFile(path, "utf8").catch(() => null) !== mainSource) await writeFile(path, mainSource);
  return compile(path, buildDir);
}

export async function compileCircuit(path: string): Promise<CompiledCircuit> {
  const absolute = resolve(repoRoot, path);
  const key = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  return compile(absolute, join(buildDir, `${basename(path, ".circom")}-${key}`));
}

export async function witness(compiled: CompiledCircuit, input: CircuitSignals): Promise<bigint[]> {
  await mkdir(buildDir, { recursive: true });
  const temporary = await mkdtemp(join(buildDir, "witness-"));
  try {
    const path = join(temporary, "witness.wtns");
    // A failed calculation leaves snarkjs's output handle open, so calculate in memory first.
    const output: { type: "mem"; data?: Uint8Array } = { type: "mem" };
    await wtns.calculate(input, compiled.wasm, output);
    assert.ok(output.data);
    await writeFile(path, output.data);
    return (await wtns.exportJson(path) as Array<string | bigint>).map(BigInt);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function expectNoWitness(compiled: CompiledCircuit, input: CircuitSignals): Promise<void> {
  await assert.rejects(() => witness(compiled, input));
}

async function info(compiled: CompiledCircuit) {
  const result = await r1cs.info(compiled.r1cs);
  curves.add(result.curve);
  return result;
}

function integerLE(value: bigint, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
}

export async function checkWitness(compiled: CompiledCircuit, values: readonly bigint[]): Promise<boolean> {
  const header = await info(compiled);
  if (values.length !== header.nVars || values[0] !== 1n || values.some((v) => v < 0n || v >= header.prime)) return false;
  // WTNS v2 has a field header and a little-endian array of canonical field elements.
  const fieldHeader = Buffer.concat([integerLE(BigInt(header.n8), 4), integerLE(header.prime, header.n8), integerLE(BigInt(values.length), 4)]);
  const data = Buffer.concat(values.map((value) => integerLE(value, header.n8)));
  const binary = Buffer.concat([
    Buffer.from("wtns"), integerLE(2n, 4), integerLE(2n, 4),
    integerLE(1n, 4), integerLE(BigInt(fieldHeader.length), 8), fieldHeader,
    integerLE(2n, 4), integerLE(BigInt(data.length), 8), data,
  ]);
  return Boolean(await wtns.check(compiled.r1cs, binary, logger));
}

export async function constraintCount(compiled: CompiledCircuit): Promise<number> {
  return (await info(compiled)).nConstraints;
}
