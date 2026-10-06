import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { assertName, repoRoot, setCheckMode, terminateCurveWorkers, writeModule } from "./lib.js";
import type { FixtureModule } from "./lib.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  setCheckMode(check);
  const requested = args.filter((arg) => arg !== "--check");
  requested.forEach(assertName);
  const directory = join(repoRoot, "contracts/fixtures/scenarios");
  const available = (await readdir(directory)).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => name.slice(0, -3)).sort();
  const names = requested.length === 0 ? available : [...new Set(requested)];
  for (const name of names) {
    if (!available.includes(name)) throw new Error(`Unknown scenario: ${name}`);
  }
  for (const name of names) {
    const scenario = await import(pathToFileURL(join(directory, `${name}.ts`)).href) as { default: () => Promise<FixtureModule> };
    await writeModule(name, await scenario.default());
    console.log(`${check ? "Checked" : "Generated"} ${name}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Fixture generation failed");
  process.exitCode = 1;
} finally {
  await terminateCurveWorkers();
}
