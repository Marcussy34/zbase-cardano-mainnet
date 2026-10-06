import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { groth16 } from "snarkjs";
import type { CircuitSignals, Groth16Proof } from "snarkjs";
import {
  R, ZERO_HASHES, proofToCardano, vkToCardano,
} from "@zbase-cardano/crypto";
import type {
  CardanoProof, CardanoVk, Credential, Payout, PayoutAddress, SettleIntent, SnarkjsVk,
} from "@zbase-cardano/crypto";
import type { Proof as TrieProof } from "@aiken-lang/merkle-patricia-forestry";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export type Circuit = "insert" | "spend" | "ragequit";
export interface FixtureConstant {
  name: string;
  type: string;
  expression: string;
  doc?: string;
}
export interface FixtureModule {
  uses: string[];
  constants: FixtureConstant[];
}
export interface OutputReference {
  txId: Uint8Array;
  outputIndex: number;
}
export interface PoolDatum {
  roots: bigint[];
  size: bigint;
  queue: bigint[];
  nullifierRoot: Uint8Array;
  feesAccrued: bigint;
}
export interface ConfigDatum {
  admins: Uint8Array[];
  adminThreshold: bigint;
  treasury: PayoutAddress;
  depositsPaused: boolean;
  minDeposit: bigint;
  maxDeposit: bigint;
  poolCap: bigint;
  depositFeeBps: bigint;
  settleFeeBps: bigint;
  crankFee: bigint;
}

export function int(value: bigint | number | string): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Unsafe Aiken integer");
  return BigInt(value).toString();
}
export function bytes(value: Uint8Array): string {
  return `#"${Buffer.from(value).toString("hex")}"`;
}
export function bool(value: boolean): string { return value ? "True" : "False"; }
export function list(values: readonly string[]): string { return `[${values.join(", ")}]`; }
export function option(value: string | null): string { return value === null ? "None" : `Some(${value})`; }
function record(name: string, fields: Record<string, string>): string {
  return `${name} { ${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join(", ")} }`;
}
export function proof(value: CardanoProof): string {
  return record("groth16.Proof", { a: bytes(value.a), b: bytes(value.b), c: bytes(value.c) });
}
export function verificationKey(value: CardanoVk): string {
  return record("groth16.VerificationKey", {
    alpha: bytes(value.alpha), beta: bytes(value.beta), gamma: bytes(value.gamma),
    delta: bytes(value.delta), ic: list(value.ic.map(bytes)),
  });
}
export function outputReference(value: OutputReference): string {
  return record("OutputReference", { transaction_id: bytes(value.txId), output_index: int(value.outputIndex) });
}
function credential(value: Credential): string {
  return `${value.kind === "key" ? "VerificationKey" : "Script"}(${bytes(value.hash)})`;
}
export function address(value: PayoutAddress): string {
  return record("Address", {
    payment_credential: credential(value.payment),
    stake_credential: option(value.stake === null ? null : `Inline(${credential(value.stake)})`),
  });
}
export function payout(value: Payout): string {
  return record("Payout", {
    address: address(value.address), amount: int(value.amount),
    datum_hash: option(value.datumHash === null ? null : bytes(value.datumHash)),
  });
}
export function settleIntent(value: SettleIntent): string {
  return record("SettleIntent", {
    pool_id: bytes(value.poolId), payouts: list(value.payouts.map(payout)),
    relayer: option(value.relayer === null ? null : bytes(value.relayer)), valid_until: int(value.validUntil),
  });
}
export function poolDatum(value: PoolDatum): string {
  return record("PoolDatum", {
    roots: list(value.roots.map(int)), size: int(value.size), queue: list(value.queue.map(int)),
    nullifier_root: bytes(value.nullifierRoot), fees_accrued: int(value.feesAccrued),
  });
}
export function configDatum(value: ConfigDatum): string {
  return record("ConfigDatum", {
    admins: list(value.admins.map(bytes)), admin_threshold: int(value.adminThreshold),
    treasury: address(value.treasury), deposits_paused: bool(value.depositsPaused),
    min_deposit: int(value.minDeposit), max_deposit: int(value.maxDeposit), pool_cap: int(value.poolCap),
    deposit_fee_bps: int(value.depositFeeBps), settle_fee_bps: int(value.settleFeeBps), crank_fee: int(value.crankFee),
  });
}
export function trieProof(value: TrieProof): string { return value.toAiken().trim(); }

const repeated = (hex: string, count = 28): Uint8Array => Buffer.from(hex.repeat(count), "hex");
const keyAddress = (hash: Uint8Array): PayoutAddress => ({ payment: { kind: "key", hash }, stake: null });
const scriptAddress = (hash: Uint8Array): PayoutAddress => ({ payment: { kind: "script", hash }, stake: null });
// Keep these public test values aligned with pool/kit.ak and testkit.ak.
export const samples = {
  keyHash1: repeated("11"), keyHash2: repeated("22"), keyHash3: repeated("33"), keyHash4: repeated("44"),
  scriptHash1: repeated("55"), scriptHash2: repeated("66"), poolId: repeated("77"),
  outputReference1: { txId: repeated("aa", 32), outputIndex: 0 },
  outputReference2: { txId: repeated("aa", 32), outputIndex: 1 },
  outputReference3: { txId: repeated("aa", 32), outputIndex: 2 },
  poolAddress: scriptAddress(repeated("55")), configAddress: scriptAddress(repeated("88")),
  aspAddress: scriptAddress(repeated("99")), treasuryAddress: keyAddress(repeated("44")),
  payoutAddress: keyAddress(repeated("22")),
};
export const emptyStateRoot = ZERO_HASHES[32]!;
// The JS library represents an empty root as null; Aiken uses 32 zero bytes.
export const emptyNullifierRoot = new Uint8Array(32);
export const m0Config: ConfigDatum = {
  admins: [samples.keyHash1, samples.keyHash2, samples.keyHash3], adminThreshold: 2n,
  treasury: samples.treasuryAddress, depositsPaused: false, minDeposit: 5_000_000n,
  maxDeposit: 50_000_000n, poolCap: 500_000_000n, depositFeeBps: 0n,
  settleFeeBps: 0n, crankFee: 300_000n,
};
export const genesisDatum: PoolDatum = {
  roots: [emptyStateRoot], size: 0n, queue: [], nullifierRoot: emptyNullifierRoot, feesAccrued: 0n,
};

let checkOnly = false;
export function setCheckMode(value: boolean): void { checkOnly = value; }
export function assertName(name: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid fixture name: ${name}`);
}
async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function writeGenerated(path: string, content: string): Promise<void> {
  if (await readOptional(path) === content) return;
  if (checkOnly) throw new Error(`Generated file would change: ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
export async function writeModule(name: string, module: FixtureModule): Promise<void> {
  assertName(name);
  const names = new Set<string>();
  const constants = module.constants.map((constant) => {
    assertName(constant.name);
    if (names.has(constant.name)) throw new Error(`Duplicate constant: ${constant.name}`);
    names.add(constant.name);
    const doc = constant.doc === undefined ? "" : constant.doc.split("\n").map((line) => `/// ${line}\n`).join("");
    return `${doc}pub const ${constant.name}: ${constant.type} =\n  ${constant.expression}\n`;
  });
  const content = [
    `//// Generated from contracts/fixtures/scenarios/${name}.ts. Do not edit.`,
    module.uses.join("\n"), ...constants,
  ].join("\n\n") + "\n";
  if (/[\u2013\u2014]/u.test(content)) throw new Error("Generated fixtures must not contain long dash punctuation");
  await writeGenerated(join(repoRoot, "contracts/lib/zbase/fixtures", `${name}.ak`), content);
}

export async function readVerificationKey(circuit: Circuit): Promise<SnarkjsVk> {
  return JSON.parse(await readFile(join(repoRoot, "artifacts/dev", `${circuit}_vkey.json`), "utf8")) as SnarkjsVk;
}
export async function cardanoVerificationKey(circuit: Circuit): Promise<CardanoVk> {
  return vkToCardano(await readVerificationKey(circuit));
}
// Sort object keys so callers can construct equivalent witnesses in any order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Unsafe circuit input");
  if (!["string", "number", "bigint"].includes(typeof value)) throw new Error("Invalid circuit input");
  const scalar = BigInt(value as string | number | bigint);
  if (scalar < 0n || scalar >= R) throw new Error("Circuit input must satisfy 0 <= x < r");
  return JSON.stringify(scalar.toString());
}
interface CacheEntry {
  digest: string;
  circuit: Circuit;
  proof: Groth16Proof;
  publicSignals: string[];
}
export interface CachedProof {
  proof: CardanoProof;
  publicInputs: bigint[];
  publicSignals: string[];
}
export function publicInputs(signals: readonly string[], count: number): bigint[] {
  if (signals.length !== count) throw new Error(`Expected ${count} public signals, got ${signals.length}`);
  return signals.map((signal) => {
    if (typeof signal !== "string" || !/^(0|[1-9][0-9]*)$/.test(signal)) throw new Error("Public signal must be an unsigned decimal integer");
    const value = BigInt(signal);
    // snarkjs reduces signals modulo r, so validate before verification.
    if (value >= R) throw new Error("Public signal must satisfy 0 <= x < r");
    return value;
  });
}
export async function proveCached(scenario: string, key: string, circuit: Circuit, input: CircuitSignals): Promise<CachedProof> {
  assertName(scenario);
  assertName(key);
  if (!["insert", "spend", "ragequit"].includes(circuit)) throw new Error("Unknown circuit");
  const vkBytes = await readFile(join(repoRoot, "artifacts/dev", `${circuit}_vkey.json`));
  const vk = JSON.parse(vkBytes.toString("utf8")) as SnarkjsVk;
  const orders = JSON.parse(await readFile(join(repoRoot, "artifacts/public-signals.json"), "utf8")) as Record<Circuit, string[]>;
  const count = orders[circuit].length;
  if (vk.nPublic !== count) throw new Error(`${circuit}: verification key and public signal order disagree`);
  const digest = createHash("sha256").update(circuit).update("\0").update(canonical(input)).update("\0").update(vkBytes).digest("hex");
  const cachePath = join(repoRoot, "contracts/fixtures/cache", `${scenario}.json`);
  const cacheText = await readOptional(cachePath);
  const cache = (cacheText === null ? {} : JSON.parse(cacheText)) as Record<string, CacheEntry>;
  let entry = cache[key];
  let accepted = false;
  if (entry?.digest === digest && entry.circuit === circuit) {
    publicInputs(entry.publicSignals, count);
    try {
      proofToCardano(entry.proof);
      accepted = await groth16.verify(vk, entry.publicSignals, entry.proof);
    } catch { accepted = false; }
  }
  if (!accepted) {
    if (checkOnly) throw new Error(`${scenario}/${key}: proof cache is missing, stale, or invalid; run the generator without --check`);
    const localKey = join(repoRoot, "circuits/build/dev", `${circuit}_vkey.json`);
    const localBytes = await readFile(localKey).catch(() => null);
    if (localBytes === null) throw new Error(`${scenario}/${key}: cache miss requires local development proving keys (${localKey})`);
    if (!localBytes.equals(vkBytes)) throw new Error(`${circuit}: local verification key differs from artifacts/dev; refusing to use another setup's proving key`);
    const wasm = join(repoRoot, "circuits/build", `${circuit}_js`, `${circuit}.wasm`);
    const zkey = join(repoRoot, "circuits/build/dev", `${circuit}.zkey`);
    for (const path of [wasm, zkey]) {
      if (!await stat(path).catch(() => null)) throw new Error(`${scenario}/${key}: cache miss requires ${path}`);
    }
    console.log(`Proving ${scenario}/${key} (${circuit})`);
    const result = await groth16.fullProve(input, wasm, zkey);
    publicInputs(result.publicSignals, count);
    proofToCardano(result.proof);
    if (!await groth16.verify(vk, result.publicSignals, result.proof)) throw new Error(`${scenario}/${key}: proof does not verify against artifacts/dev`);
    entry = { digest, circuit, proof: result.proof, publicSignals: result.publicSignals };
    cache[key] = entry;
    const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
    await writeGenerated(cachePath, JSON.stringify(sorted, null, 2) + "\n");
  }
  return { proof: proofToCardano(entry!.proof), publicInputs: publicInputs(entry!.publicSignals, count), publicSignals: entry!.publicSignals };
}

export async function terminateCurveWorkers(): Promise<void> {
  // Like circuits/test/harness.ts, terminate snarkjs's cached curve workers.
  const runtime = globalThis as typeof globalThis & { curve_bls12381?: { terminate(): Promise<void> } | null };
  await runtime.curve_bls12381?.terminate();
}
