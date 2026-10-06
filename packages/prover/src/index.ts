import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import type { CircuitSignals } from "snarkjs";
import { isCanonical, proofToCardano } from "@zbase-cardano/crypto";
import type { SnarkjsProof, SnarkjsVk, CardanoProof } from "@zbase-cardano/crypto";

export type CircuitName = "spend" | "insert" | "ragequit";

/** One circuit's artifacts, supplied as paths or checked bytes. */
export interface CircuitArtifacts {
  wasm: string | Uint8Array;
  zkey: string | Uint8Array;
  vkey: SnarkjsVk;
}

/** The circuits section of the ceremony manifest. */
export interface CircuitManifest {
  [circuit: string]: {
    wasm_sha256: string;
    zkey_sha256: string;
    vkey_sha256: string;
    r1cs_sha256?: string;
  };
}

export interface ProofResult {
  proof: SnarkjsProof;
  publicSignals: bigint[];
  cardano: CardanoProof;
}

interface Curve {
  terminate(): Promise<void>;
}

// snarkjs 0.7.6 exports curves, but @types/snarkjs 0.7.9 omits that export.
const { curves } = snarkjs as typeof snarkjs & {
  curves: { getCurveFromName(name: string): Promise<Curve> };
};
let curve: Promise<Curve> | undefined;

function getCurve(): Promise<Curve> {
  // Share initialization as well as the handle so concurrent callers use one worker pool.
  return curve ??= curves.getCurveFromName("bls12-381");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function checkedBytes(path: string, expected: string | undefined): Promise<Buffer> {
  const bytes = await readFile(path);
  if (sha256(bytes) !== expected) throw new Error(`SHA-256 mismatch for ${path}`);
  return bytes;
}

/** Checks the manifest against file bytes and returns those same bytes for proving. */
export async function loadArtifacts(a: {
  circuit: CircuitName; wasmPath: string; zkeyPath: string; vkeyPath: string; manifest: CircuitManifest;
}): Promise<CircuitArtifacts> {
  const expected = a.manifest[a.circuit];
  const [wasm, zkey, vkey] = await Promise.all([
    checkedBytes(a.wasmPath, expected?.wasm_sha256),
    checkedBytes(a.zkeyPath, expected?.zkey_sha256),
    checkedBytes(a.vkeyPath, expected?.vkey_sha256),
  ]);
  // Returning bytes prevents a later file replacement from bypassing the hash check.
  return { wasm, zkey, vkey: JSON.parse(vkey.toString("utf8")) as SnarkjsVk };
}

/** Builds a proof locally and verifies it before converting its points for Cardano. */
export async function prove(artifacts: CircuitArtifacts, input: Record<string, unknown>): Promise<ProofResult> {
  await getCurve();
  const result = await snarkjs.groth16.fullProve(input as CircuitSignals, artifacts.wasm, artifacts.zkey);
  const publicSignals = result.publicSignals.map(BigInt);
  if (!await verify(artifacts.vkey, publicSignals, result.proof)) {
    throw new Error("Generated proof failed verification");
  }
  return { proof: result.proof, publicSignals, cardano: proofToCardano(result.proof) };
}

/** Rejects noncanonical signals before snarkjs can process them. */
export async function verify(vkey: SnarkjsVk, publicSignals: readonly bigint[], proof: SnarkjsProof): Promise<boolean> {
  if (!publicSignals.every(isCanonical)) return false;
  if (publicSignals.length !== vkey.IC.length - 1) return false;
  if (vkey.nPublic !== undefined && publicSignals.length !== vkey.nPublic) return false;
  if ((vkey.curve !== undefined && vkey.curve !== "bls12381")
    || (proof.curve !== undefined && proof.curve !== "bls12381")
    || (vkey.protocol !== undefined && vkey.protocol !== "groth16")
    || (proof.protocol !== undefined && proof.protocol !== "groth16")) return false;
  await getCurve();
  try {
    return await snarkjs.groth16.verify(
      { ...vkey, curve: "bls12381" }, publicSignals.map(String),
      { ...proof, protocol: "groth16", curve: "bls12381" },
    );
  } catch {
    // Malformed points are invalid proofs, just like a failed pairing check.
    return false;
  }
}

/** Releases the shared curve workers after callers finish proving and verifying. */
export async function shutdown(): Promise<void> {
  const current = curve;
  curve = undefined;
  if (current) await (await current).terminate();
}

/** Loads local development keys only when they match the committed setup run. */
export async function loadDevArtifacts(circuit: CircuitName, repoRoot: string): Promise<CircuitArtifacts> {
  const build = join(repoRoot, "circuits/build");
  const vkeyPath = join(build, "dev", `${circuit}_vkey.json`);
  try {
    const manifest = JSON.parse(await readFile(join(build, "dev/manifest.json"), "utf8")) as { circuits: CircuitManifest };
    const [localVkey, committedVkey] = await Promise.all([
      readFile(vkeyPath), readFile(join(repoRoot, "artifacts/dev", `${circuit}_vkey.json`)),
    ]);
    if (!localVkey.equals(committedVkey)) {
      throw new Error(`${vkeyPath} differs from artifacts/dev/${circuit}_vkey.json; the local keys come from another setup run`);
    }
    return await loadArtifacts({
      circuit, wasmPath: join(build, `${circuit}_js`, `${circuit}.wasm`),
      zkeyPath: join(build, "dev", `${circuit}.zkey`), vkeyPath, manifest: manifest.circuits,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing development artifacts for ${circuit}. Run npm run build:circuits, then npm run setup:dev.`, { cause: error });
    }
    throw error;
  }
}

/** CI can skip proving without generating or changing development keys. */
export function devKeysPresent(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "circuits/build/dev/manifest.json"));
}

/** Loads and checks a committed verification key without accessing proving keys. */
export async function loadDevVkey(circuit: CircuitName, repoRoot: string): Promise<SnarkjsVk> {
  const directory = join(repoRoot, "artifacts/dev");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { circuits: CircuitManifest };
  const bytes = await checkedBytes(join(directory, `${circuit}_vkey.json`), manifest.circuits[circuit]?.vkey_sha256);
  return JSON.parse(bytes.toString("utf8")) as SnarkjsVk;
}
