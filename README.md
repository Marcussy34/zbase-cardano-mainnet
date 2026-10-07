# zBase Cardano (mainnet)

Private payments for AI agents using tUSDM on Preprod, with Cardano mainnet planned.
An agent deposits into a shared pool once.
Later it pays sellers, escrows, or payment channels from the pool with a zero-knowledge proof.
The chain shows the pool as the payer, not the agent's wallet.

**Status (2026-10-07):** the first release, M0, is built and runs on the Preprod test network.
On Preprod an agent deposited, paid a stock x402 seller through a one-time address, and exited the rest, with the code of this repository.
Mainnet is not deployed yet. Nobody outside this project has reviewed the design or the code.

**New here? Read [docs/HANDOFF.md](docs/HANDOFF.md) first.**

The documentation site at [marcussy34.github.io/zbase-cardano-mainnet](https://marcussy34.github.io/zbase-cardano-mainnet/) explains how it works in plain words and carries every document from `docs/`. Run it locally with `npm run docs:dev`.

## Try it

1. Install the tools: `npm ci`
2. Run the tests: `npm test`
3. Compile the circuits and make the development keys: `npm run build:circuits`, then `npm run setup:dev`
4. Run the tests again. The tests that need proofs no longer skip.

Step 3 takes about 30 minutes the first time. Without it, every test that needs a proving key skips with a clear message.

To run the whole product on the Preprod test network, follow [docs/RUNBOOK-PREPROD.md](docs/RUNBOOK-PREPROD.md).
It ends with one command that deposits, pays an x402 seller in private, and exits.

## Run the frontend

The public landing page and documentation reader are in `apps/web`.
Run these commands from the repo root:

```sh
npm ci
npm run dev
npm test -w apps/web
npm run build
```

The landing page explains the ADA pool, local proofs, and private payments.
`Read docs` opens a local reader at `/docs/` with the current product requirements, design, and M0 plan.
The page has no wallet connection or transaction functions. M0 runs on Preprod; mainnet is not deployed yet.
`npm test -w apps/web` runs the frontend checks. `npm test` runs all workspace tests.

## What is in the repository

| Folder | What it holds |
|---|---|
| `apps/web` | The public landing page and documentation reader |
| `apps/docs` | The documentation site, built with Nextra and published to GitHub Pages |
| `circuits/` | The three circom circuits: spend, insert and ragequit |
| `contracts/` | The Aiken validators: pool, deposit, config, association set, and the token policy |
| `packages/crypto` | Hashes, notes, trees, encodings and key derivation |
| `packages/prover` | Proving and verifying with snarkjs |
| `packages/txlib` | Transaction builders, the Blockfrost provider, and a local test chain that runs the real validators |
| `packages/api` | The HTTP contracts of the indexer and the relayer, with clients |
| `packages/sdk` | The agent SDK, `@zbase-cardano/core`, with the stealth x402 signer |
| `services/` | The indexer, the crank, the association set provider service and the relayer |
| `ops/` | Key setup, deploy, the one-process node, the demo and the admin command |
| `examples/x402-seller` | A stock x402 seller that knows nothing about the pool |
| `deployments/` | The record of the Preprod pool and its verification keys |
| `artifacts/` | Development verification keys and the order of public signals |

## Documents

| Document | What it covers |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | Start here: reading order, what is decided, what is verified, first tasks |
| [docs/PRD.md](docs/PRD.md) | Product requirements: users, scope, requirements, releases, risks |
| [docs/SPEC.md](docs/SPEC.md) | The design: cryptography, circuits, validators, transactions, x402 modes |
| [docs/PLAN-M0.md](docs/PLAN-M0.md) | Build plan for the first mainnet release: work packages and interfaces |
| [docs/TEST-PLAN.md](docs/TEST-PLAN.md) | Every test, with a stable ID, mapped to the Spec rules |
| [docs/TEST-VECTORS.md](docs/TEST-VECTORS.md) | Known answers for hashes, encodings, and proofs |
| [docs/SETUP.md](docs/SETUP.md) | Tools, versions, and known pitfalls |
| [docs/RUNBOOK-PREPROD.md](docs/RUNBOOK-PREPROD.md) | Run the whole product on the Preprod test network, with the exact commands |
| [docs/RUNBOOK-M0.md](docs/RUNBOOK-M0.md) | Step-by-step mainnet canary |
| [docs/CEREMONY.md](docs/CEREMONY.md) | The Groth16 setup ceremony |
| [docs/measurements.md](docs/measurements.md) | Measured costs, and every transaction of the Preprod runs |
| [docs/research/](docs/research/) | Evidence: measurements, research digests, and two verified spikes |
| [AGENTS.md](AGENTS.md) | Hard rules for people and AI agents |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow and pull request checklist |

## The design in five lines

1. Notes live as commitments in a Poseidon Merkle tree. Funds sit in one pool UTXO.
2. A Groth16 proof over BLS12-381 authorizes every private payment.
3. The validator never hashes Poseidon. A second proof covers every tree update.
4. Spent notes are tracked in a Merkle Patricia Forestry root.
5. Payments reach stock x402 sellers through a one-time key (stealth mode).

## What fits and what does not

- It fits payments of a few ADA or more, and private funding of escrows, payment channels, and tabs.
- It does not fit cent-sized payments settled one by one. Cardano makes every output hold about 1 ADA.

## Origin

zBase runs on Base today as a Privacy Pools fork with an x402 facilitator.
This design adapts that architecture to Cardano's ledger limits.
It replaces the earlier notes in the private `zbase-cardano` repo.

## License

MIT. See [LICENSE](LICENSE).

Dependencies keep their own licenses.
The prover uses snarkjs, which is GPL-3.0.
Check that before you ship a product that bundles it.
