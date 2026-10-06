# Research spikes

These three folders hold throwaway code that proved parts of the design on 2026-10-06.
They are evidence and a working reference. They are not product code, and nothing here is reviewed for production use.

| Folder | What it proves | Result |
|---|---|---|
| [poseidon-vectors](./poseidon-vectors/) | The circom Poseidon255 circuits and the TypeScript library give the same hashes | 26 of 26 checks pass |
| [groth16-pipeline](./groth16-pipeline/) | A snarkjs Groth16 proof on curve `bls12-381` verifies in Aiken after point conversion. The nullifier trie library compiles with Aiken 1.1.24 | 34 of 34 checks pass |
| [mesh-offline-settle](./mesh-offline-settle/) | The Mesh SDK builds, balances, evaluates, signs, and chains a Settle-shaped Plutus V3 transaction with no network access | 10 of 10 probes pass. One open point: the two local evaluators differ by 6,243 CPU steps |

Each folder has a `REPORT.md` with versions, commands, results, and pitfalls.

## How to rerun

Poseidon vectors:

1. Run `npm install` in `poseidon-vectors/`.
2. Run `bash verify.sh`. It prints one `PASS` or `FAIL` line per check.

Groth16 pipeline:

1. Run `npm install` in `groth16-pipeline/`.
2. Download Aiken 1.1.24 into `groth16-pipeline/tools/aiken-1.1.24/`, as the report's setup section shows. The scripts expect the macOS arm64 path. On another system, edit the `AIKEN` line in `verify.sh` and `scripts/mpf_matrix.sh`.
3. Run `bash verify.sh --force`.

Mesh offline Settle:

1. Run `npm ci` in the repo root.
2. Run `npx aiken build` inside `mesh-offline-settle/stub/`.
3. Run `node --import tsx docs/research/spikes/mesh-offline-settle/settle-shape.spike.ts` from the repo root. It prints one `PASS` or `FAIL` line per probe.

A rerun with `--force` makes a new development key, so its hex values differ from the committed vectors. The committed vectors belong to the original run.

CAUTION: the keys in these spikes come from a one-person setup with public entropy. Never reuse them.
