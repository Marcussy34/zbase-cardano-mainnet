# zBase Cardano (mainnet)

Private payments for AI agents on Cardano mainnet.
An agent deposits into a shared pool once.
Later it pays sellers, escrows, or payment channels from the pool with a zero-knowledge proof.
The chain shows the pool as the payer, not the agent's wallet.

**Status:** the design is approved (2026-10-06). This repo holds the documentation and verified test vectors. No product code exists yet.

**New here? Read [docs/HANDOFF.md](docs/HANDOFF.md) first.**

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
| [docs/RUNBOOK-M0.md](docs/RUNBOOK-M0.md) | Step-by-step mainnet canary |
| [docs/CEREMONY.md](docs/CEREMONY.md) | The Groth16 setup ceremony |
| [docs/measurements.md](docs/measurements.md) | Template for measured costs, filled during M0 |
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

Not set yet. zBase on Base uses Apache-2.0.
