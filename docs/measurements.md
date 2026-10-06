# zBase Cardano: Measurements

Fill this file during M0. It replaces the estimates in [SPEC.md](./SPEC.md) section 10.
Measured values that are already known are in [research/2026-10-06-measurements.md](./research/2026-10-06-measurements.md).

## 1. Circuits

| Circuit | Constraints | Setup power | Proving time | Proving key size |
|---|---|---|---|---|
| `spend` | 16,828 | 15 | 1.5 to 1.9 s | 14,285,885 bytes |
| `insert` | 62,950 | 16 | 4.3 to 4.8 s | 47,067,202 bytes |
| `ragequit` | 8,423 | 14 | 1.0 s | 7,141,180 bytes |

The setup power is the smallest one that fits the circuit. snarkjs needs one row per constraint, one per public signal, and one more.
One shared powers of tau file of power 16 serves all three circuits. Its size is 113,248,170 bytes.
The proving key sizes are for the development keys.
Proving times were measured on an Apple M2 Max with Node 24.10.0 and snarkjs 0.7.6, while other builds ran. Each time covers the witness, the proof, and a check of the proof.

## 2. Scripts

| Script | Size in bytes | Script hash |
|---|---|---|
| `pool` | | |
| `deposit` | | |
| `config` | | |
| `asp` | | |
| `nft` | | |

## 3. Transactions on mainnet

| Transaction | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | | | | | |
| Refund | | | | | |
| Insert, 1 deposit | | | | | |
| Insert, 1 note | | | | | |
| Insert, 4 slots | | | | | |
| Settle, 1 payout | | | | | |
| Settle, 4 payouts | | | | | |
| Ragequit | | | | | |
| Stealth leg 2 | | | | | |
| ASP update | | | | | |
| Config update | | | | | |

## 4. End-to-end timings

| Flow | Time from request to one confirmation |
|---|---|
| Stealth payment, one-time key funded on demand | |
| Stealth payment, one-time key funded ahead | |

## 5. Differences from the Spec estimates

List each estimate in SPEC section 10 that was wrong by more than 20%, and update the Spec.

## 6. Contract building blocks

Measured in Aiken 1.1.24 unit tests on 2026-10-06. Each number includes the small cost of the test itself.

| Function | Case | CPU steps | Memory units |
|---|---|---|---|
| `groth16.verify` | 2 public inputs, both non-zero | 2,161,608,033 | 90,539 |
| `groth16.verify` | 2 public inputs, one of them 0 | 2,030,928,410 | 89,021 |
| `encoding.label` | one deposit | 5,815,539 | 11,279 |
| `encoding.context` | 1 payout | 20,442,216 | 49,829 |
| `encoding.context` | 4 payouts, each with a script credential, a stake credential, and a datum hash | 65,137,024 | 171,572 |
| `encoding.nullifier_key` | one key | 1,598,855 | 1,105 |
| `groth16.verify`, real `insert` proof | 15 public inputs, 9 of them 0 | 2,604,890,058 | 270,047 |
| `groth16.verify`, real `spend` proof | 6 public inputs | 2,700,200,044 | 150,443 |
| `groth16.verify`, real `ragequit` proof | 4 public inputs | 2,430,918,152 | 120,491 |

A skipped zero input saves 130,679,623 CPU. So one proof check costs about 1.90B CPU plus 0.131B for each non-zero public input.
That is close to the model in SPEC 10.2 (1.87B plus 0.13B).

## 7. Off-chain library

Measured on an Apple M2 Max with Node 24.10.0 on 2026-10-06.

| Operation | Result |
|---|---|
| One Poseidon255 `h2` call | about 0.17 ms |
| Append 200 leaves, then read the root once | 226 hash calls |
| Set one leaf, then read the root | 32 hash calls |

## 8. Development key setup

Measured on an Apple M2 Max with Node 24.10.0 and snarkjs 0.7.6 on 2026-10-06.
The machine ran other builds at the same time, so read the long steps as upper bounds.

| Step | Time |
|---|---|
| Compile the three circuits, forced | about 26 s |
| Compile the three circuits, nothing changed | about 1 s |
| Powers of tau, power 16: contribute | 44 to 51 s |
| Powers of tau, power 16: prepare phase 2 | 923 to 1,145 s |
| Powers of tau, power 16: verify | 17 s |
| Groth16 setup for `spend`, `insert`, `ragequit` | 71 s, 96 s, 46 s |
| Full setup, first run | 1,663 s |
| Setup when every key is cached | under 1 s |

Two forced builds gave the same R1CS files, so the circuit build is reproducible.

| Circuit | R1CS SHA-256 |
|---|---|
| `spend` | `f7cbe870ef2fa3897cc61f62ea3382617c4b5f7539421aee7c7809b96dae31cf` |
| `insert` | `c1fec5a85f5e84ce270cb327d0548f7a9bfeeb144067fa13494f86b41007c7ca` |
| `ragequit` | `ec97e315ebf705e07913f7de0dec0c9fd79423fbfe1e5c73c48de580bffde91c` |

The keys are not reproducible. snarkjs mixes 64 random bytes from the operating system into every contribution, even when the caller passes a fixed text.
So each machine gets its own development keys, and proof fixtures must carry the verification key they were made with.
