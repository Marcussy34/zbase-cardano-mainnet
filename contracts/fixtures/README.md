# Aiken proof fixtures

Run commands from the repository root with the existing dependencies.
Development keys and these fixtures are public test material. Never use them for real funds.

```bash
node --import tsx contracts/fixtures/gen.ts
node --import tsx contracts/fixtures/gen.ts --check
node --import tsx contracts/fixtures/gen.ts demo
npx tsc --noEmit -p contracts/fixtures
npm run check:contracts
npm run check:budgets
```

With no names, the generator discovers every `scenarios/*.ts` file and runs them in sorted order.
Names select only those scenarios. Unknown names and flags fail before generation.
Each scenario writes `contracts/lib/zbase/fixtures/<name>.ak` with a source header.
The writer preserves identical files without rewriting them.

`--check` never writes modules or caches. It exits 1 for changed output or a missing, stale, or invalid cached proof.
A complete cache needs only the committed verification keys, so `--check` also works without `circuits/build`.
Run without `--check` to generate missing proofs.

## Add a scenario

1. Create `contracts/fixtures/scenarios/<name>.ts` with a lowercase name containing letters, digits, or underscores.
2. Export `default async function build(): Promise<FixtureModule>`.
3. Build witnesses with `@zbase-cardano/crypto` and sample values from `lib.ts`.
4. Call `proveCached(name, key, circuit, witness.input)` once for each proof.
5. Assert that `result.publicInputs` equals `witness.publicInputs` to guard public signal order.
6. Return the module's `uses` and `constants` lists.
7. Generate the named scenario.

```bash
node --import tsx contracts/fixtures/gen.ts <name>
```

8. Check that regenerating changes nothing.

```bash
node --import tsx contracts/fixtures/gen.ts --check <name>
```

9. Add Aiken tests that consume the constants and use IDs from `docs/TEST-PLAN.md`.
10. Run the TypeScript, contract, and budget checks shown above.

Keep the scenario source, generated module, and its cache together in the change submitted to the lead.
Never include witness secrets, proving keys, or setup files.
Use a public, fixed test seed when a scenario needs note secrets.

## Module and emitter interface

```typescript
import { int, list, proof, proveCached } from "../lib.js";
import type { FixtureModule } from "../lib.js";

// Inside build(), after constructing a witness:
const result = await proveCached("my_case", "insert_one", "insert", witness.input);
const module: FixtureModule = {
  uses: ["use zbase/groth16"],
  constants: [
    { name: "insert_proof", type: "groth16.Proof", expression: proof(result.proof) },
    { name: "insert_inputs", type: "List<Int>", expression: list(result.publicInputs.map(int)),
      doc: "Public inputs in artifacts/public-signals.json order." },
  ],
};
```

`FixtureModule` contains complete Aiken `use` lines and constants with `name`, `type`, `expression`, and optional `doc`.
`lib.ts` exports these expression emitters:

| Emitter | Input | Aiken expression |
| --- | --- | --- |
| `int` | bigint, safe integer, or integer string | `Int` |
| `bytes` | `Uint8Array` | `ByteArray` |
| `bool` | boolean | `Bool` |
| `list` | array of expression strings | list |
| `option` | expression string or `null` | `Some(...)` or `None` |
| `proof` | `CardanoProof` | `groth16.Proof` |
| `verificationKey` | `CardanoVk` | `groth16.VerificationKey` |
| `outputReference` | `{ txId, outputIndex }` | `OutputReference` |
| `address` | crypto `PayoutAddress` | `Address` |
| `payout` | crypto `Payout` | `Payout` |
| `settleIntent` | crypto `SettleIntent` | `SettleIntent` |
| `poolDatum` | fixture `PoolDatum` | `PoolDatum` |
| `configDatum` | fixture `ConfigDatum` | `ConfigDatum` |
| `trieProof` | JavaScript trie `Proof` | `mpf.Proof` |

The fixture datum interfaces use camelCase fields. The emitters write the snake_case fields from `zbase/types.ak`.
Import required Aiken constructors in `uses`. Addresses need `Address`, `VerificationKey` or `Script`, and `Inline` when staking is present.
Proofs and verification keys use the qualified `groth16` module to avoid the address constructor's name collision.
The scenarios are executable examples of complete imports.

`samples` mirrors `testkit.ak` and `pool/kit.ak`.
`m0Config`, `genesisDatum`, `emptyStateRoot`, and `emptyNullifierRoot` supply the shared M0 defaults.
The Aiken sample test guards these values against drift.

## Proof cache

`proveCached` returns `{ proof, publicInputs, publicSignals }`.
`proof` contains compressed Cardano points. `publicInputs` contains bigints. `publicSignals` contains decimal strings.
The cache stores only the raw snarkjs proof, public signals, circuit name, and digest in `cache/<scenario>.json`.
Each caller chooses a stable `key` within its own scenario cache.
Call proofs sequentially within one scenario because they share its cache file.

The digest covers the circuit name, canonical witness input, and exact committed verification key bytes.
Equivalent object key order and decimal scalar representations produce the same digest.
Reuse requires a matching digest and successful verification against `artifacts/dev/<circuit>_vkey.json`.
Public signals must satisfy `0 <= x < r` before snarkjs sees them.
Input scalars also receive this range check before hashing or proving.

On a cache miss, the generator compares the committed key bytes with `circuits/build/dev/<circuit>_vkey.json`.
A mismatch stops generation because the local proving key may belong to another setup.
It then requires `circuits/build/<circuit>_js/<circuit>.wasm` and `circuits/build/dev/<circuit>.zkey`.
It calls snarkjs directly, verifies the result, converts the points, and saves the proof.
Missing local artifacts produce a clear error. The generator never runs setup.

The CLI terminates snarkjs curve workers in `finally`, including after errors.
Standalone scripts that call this library must call `terminateCurveWorkers()` in their own `finally` block.

## Trie insertion proofs

Use byte buffers for nullifier keys, with `Buffer.from(nullifierKey(hash))`, and the single byte `Buffer.from([1])` for values.
Create an in-memory `Trie`, insert the key, and then call `trie.prove(key)`.
An inclusion proof after insertion proves insertion from the preceding root.
`proof.verify(false, key)` reconstructs the old root; `proof.verify(true, key)` reconstructs the new root.

The JavaScript library represents an empty root as `null`; Aiken represents it as 32 zero bytes.
Use `emptyNullifierRoot` for the latter.
`trieProof` delegates directly to `proof.toAiken()`.
Its list uses the on-chain `Branch`, `Fork`, and `Leaf` constructors, with `Neighbor` inside a fork.
Import only the constructors the scenario emits to avoid unused-import warnings.
The demo emits `[]` for the first insertion and one `Leaf` for the second.

The demo checks both roots, duplicate insertion failure, and a proof presented with the wrong key in Aiken.
The three real proof checks have bounds in `contracts/budgets.json` at approximately 110% of measured CPU and memory.
