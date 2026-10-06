# Handoff: start here

| Field | Value |
|---|---|
| For | The engineer who builds zBase Cardano |
| From | Marcus |
| Date | 2026-10-06 |
| State of the repo | Documentation and verified test vectors. No product code yet |

## 1. What you are building

zBase Cardano lets an AI agent pay on Cardano mainnet without showing which wallet paid.
The agent deposits into a shared pool, then pays from the pool with a zero-knowledge proof.
The first release is a capped ADA pool for team funds, called M0.
It adapts zBase, which runs on Base today, to Cardano's limits.

## 2. Read in this order

| # | Document | Time | Why |
|---|---|---|---|
| 1 | [PRD.md](./PRD.md) | 15 min | What we build, for whom, and what is out of scope |
| 2 | [SPEC.md](./SPEC.md) | 60 min | The design. Sections 4 to 7 are the rules you implement |
| 3 | [TEST-VECTORS.md](./TEST-VECTORS.md) | 10 min | Known answers your code must reproduce |
| 4 | [TEST-PLAN.md](./TEST-PLAN.md) | 15 min | Every test, with a stable ID |
| 5 | [PLAN-M0.md](./PLAN-M0.md) | 20 min | Work packages, interfaces, and done criteria |
| 6 | [SETUP.md](./SETUP.md) | 10 min | Tools, versions, and known pitfalls |
| 7 | [RUNBOOK-M0.md](./RUNBOOK-M0.md) and [CEREMONY.md](./CEREMONY.md) | 15 min | How M0 goes to mainnet |
| 8 | [research/](./research/) | as needed | The evidence behind each number |

[AGENTS.md](../AGENTS.md) holds the hard rules. Read it before you write code.

## 3. What is decided

The owner approved the design on 2026-10-06. SPEC section 2 lists each decision with its reason. The main ones:

- Groth16 over BLS12-381, with circom and snarkjs.
- The Privacy Pools note model, the same as zBase on Base.
- The validator never computes Poseidon. A second proof covers each tree update.
- Deposits are ordinary payments. Anyone can insert them with a proof.
- Spent notes are tracked in one Merkle Patricia Forestry root.
- Stealth mode is the default x402 path: the pool pays a one-time key, and that key pays the seller.
- The agent proves on its own machine.
- Scripts are immutable. The admin can only pause deposits and tune bounded values.

## 4. What is verified and what is assumed

| Claim | Status | Where |
|---|---|---|
| A Groth16 check fits a transaction (about a quarter of the CPU limit) | Measured | research/2026-10-06-measurements.md |
| On-chain Poseidon does not fit (1.27B CPU per hash) | Measured | Same file |
| Live mainnet limits and prices | Read from the chain on 2026-10-06 | research/data/koios-mainnet-epoch-params.json |
| A snarkjs proof on `bls12-381` verifies in Aiken after conversion | Verified in an Aiken test | research/spikes/groth16-pipeline |
| Poseidon255 in circom equals the TypeScript library | Verified, 26 of 26 checks | research/spikes/poseidon-vectors |
| The trie library compiles with Aiken 1.1.24 | Verified | Same pipeline spike |
| An input of `x + r` verifies when the range check is missing | Verified by a control test | Same pipeline spike |
| Label and context encodings | Defined, with vectors from a reference script | TEST-VECTORS sections 6 and 7 |
| Stock x402 facilitators accept the stealth payment | Read in their source and docs. Not yet run | research/2026-10-06-x402-ecosystem-digest.md |
| Fees of about 1.0 to 1.2 ADA per private payment | Estimate | SPEC section 10 |
| Circuit sizes | Estimate from measured hash sizes | SPEC section 5 |
| Mesh can build the Settle transaction | Not verified. It is your first task | PLAN-M0, WP5 |
| The community powers of tau file is usable | Not verified | CEREMONY section 2 |

The three circuits and all validators are not written yet. Nobody outside this project has reviewed the design.

## 5. Your first week

1. Do [SETUP.md](./SETUP.md) and confirm every version check.
2. Run both spikes in `research/spikes/` once. They show the toolchain working end to end.
3. Do the Mesh spike from WP5: build one Settle against a stub validator and evaluate it. Report the result before anything else depends on it.
4. Do WP0, then WP1. WP1 is done when tests CRY-01 to CRY-10 pass against the vectors.
5. Start WP2 (circuits) and the verifier part of WP3 in parallel.

## 6. Hard rules

These are the mistakes that lose funds or break privacy. [AGENTS.md](../AGENTS.md) has the full list.

- Range-check every public input on-chain: `0 <= x < r`.
- Never compute Poseidon in a validator.
- Never use `circomlibjs`. Use the two Poseidon255 libraries named in the Spec.
- Never spend a per-deposit UTXO at payment time. Funds sit in the one pool UTXO.
- Never accept a tree root without a proof.
- No pool transaction mints, withdraws rewards, or carries a certificate.
- Never submit a mainnet transaction that fails evaluation.
- Never commit a seed phrase, a signing key, or a proving key.

## 7. Decisions that need the owner

None blocks M0. PRD section 14 lists each question, its default, and when it must be decided.
The first ones to come due are the compliance data source and the operating entity. Both are needed before M1.

Ask the owner before you change any of these:

- A rule in SPEC sections 4 to 6.
- A cap, a fee bound, or an admin power.
- The x402 mode order.
- Anything that adds an operator who must be trusted.

## 8. Where things come from

| Thing | Location |
|---|---|
| zBase on Base, the source architecture | `github.com/goheesheng/zBase` |
| Privacy Pools reference contracts and circuits | `github.com/0xbow-io/privacy-pools-core` |
| The Poseidon255 circuits | `github.com/jmagan/poseidon-bls12381-circom` |
| The x402 scheme for Cardano | `github.com/x402-foundation/x402`, `specs/schemes/exact/scheme_exact_cardano.md` |
| A defensive Aiken Groth16 verifier to learn from | `github.com/ODATANO/DAYZERO` |
| A project that proves a Merkle append in-circuit on preprod | `github.com/TrustLevel/ZK-Defi-Protocol` |

## 9. Limits of this handoff

- The plan is a work breakdown. It fixes interfaces and tests, not line-by-line code.
- Estimates are marked as estimates. M0 replaces them with measurements.
- The design is new. An external audit is required before the caps are lifted.
- This repo has no license yet. zBase on Base uses Apache-2.0.
