# zBase Cardano (mainnet)

Private payments for AI agents on Cardano mainnet.
An agent deposits into a shared pool once.
Later it pays sellers, escrows, or payment channels from the pool with a zero-knowledge proof.
The chain shows the pool as the payer, not the agent's wallet.

This repo holds the product and technical design. No code yet.

## Documents

| Document | What it covers |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements: users, scope, requirements, releases, risks |
| [docs/SPEC.md](docs/SPEC.md) | Technical spec: cryptography, circuits, validators, transactions, x402 modes, rollout |

## Status

- Draft v0.1, written 2026-10-06. It needs owner review before any build starts.
- Target network: Cardano mainnet, protocol version 11.
- Testing happens on mainnet with capped own funds (see SPEC section 15).

## The design in five lines

1. Notes live as commitments in a Poseidon Merkle tree. Funds sit in one pool UTXO.
2. A Groth16 proof over BLS12-381 authorizes every private payment.
3. The validator never hashes Poseidon. A second proof covers every tree update.
4. Spent notes are tracked in a Merkle Patricia Forestry root.
5. Payments plug into `@x402/cardano` through a custom client signer.

## Origin

zBase runs on Base today as a Privacy Pools fork with an x402 facilitator.
This design adapts that architecture to Cardano's ledger limits.
It replaces the earlier notes in the private `zbase-cardano` repo.
