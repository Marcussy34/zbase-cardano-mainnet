import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBinFile } from "@iden3/binfileutils";
import { F1Field } from "ffjavascript";
import { readR1csHeader } from "r1csfile";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const buildDir = join(repoRoot, "circuits/build");
export const circuitNames = ["spend", "insert", "ragequit"];

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function circuitInfo(name) {
  const { fd, sections } = await readBinFile(join(buildDir, `${name}.r1cs`), "r1cs", 1);
  try {
    // Header inspection needs no curve arithmetic or worker pool.
    const header = await readR1csHeader(fd, sections, { getFieldFromPrime: (prime) => new F1Field(prime) });
    return { constraints: header.nConstraints, outputs: header.nOutputs, publicInputs: header.nPubInputs };
  } finally {
    await fd.close();
  }
}

export async function publicSignals(name) {
  const header = await circuitInfo(name);
  const count = header.outputs + header.publicInputs;
  const names = new Map();
  for (const row of (await readFile(join(buildDir, `${name}.sym`), "utf8")).trim().split(/\r?\n/)) {
    const [, wireText, , symbol] = row.split(",");
    const wire = Number(wireText);
    // Witness positions 1..N are outputs first, then public inputs. Ignore internal aliases.
    if (wire < 1 || wire > count || !/^main\.[^.]+$/.test(symbol ?? "")) continue;
    let signal = symbol.slice(5);
    if (name === "insert") signal = signal.replace(/^slots\[(\d+)\]\[([012])\]$/, (_, slot, field) => `${["v", "l", "x"][Number(field)]}${slot}`);
    if (names.has(wire)) throw new Error(`${name}: ambiguous public signal at wire ${wire}`);
    names.set(wire, signal);
  }
  return Array.from({ length: count }, (_, index) => {
    const signal = names.get(index + 1);
    if (!signal) throw new Error(`${name}: missing public signal at wire ${index + 1}`);
    return signal;
  });
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--summary")) throw new Error("Usage: node circuits/scripts/public-signals.mjs [--summary]");
  const signals = {};
  for (const name of circuitNames) {
    signals[name] = await publicSignals(name);
    if (process.argv.includes("--summary")) {
      console.log(`${name}: ${(await circuitInfo(name)).constraints} constraints, r1cs SHA-256 ${await sha256(join(buildDir, `${name}.r1cs`))}`);
    }
  }
  const output = join(repoRoot, "artifacts/public-signals.json");
  const bytes = `${JSON.stringify(signals, null, 2)}\n`;
  await mkdir(dirname(output), { recursive: true });
  if (await readFile(output, "utf8").catch(() => null) !== bytes) await writeFile(output, bytes);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
