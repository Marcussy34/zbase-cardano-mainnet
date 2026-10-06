# zBase Cardano: Measurements

Fill this file during M0. It replaces the estimates in [SPEC.md](./SPEC.md) section 10.
Measured values that are already known are in [research/2026-10-06-measurements.md](./research/2026-10-06-measurements.md).

## 1. Circuits

| Circuit | Constraints | Setup power | Proving time, 4-core machine | Proving key size |
|---|---|---|---|---|
| `spend` | | | | |
| `insert` | | | | |
| `ragequit` | | | | |

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

A skipped zero input saves 130,679,623 CPU. So one proof check costs about 1.90B CPU plus 0.131B for each non-zero public input.
That is close to the model in SPEC 10.2 (1.87B plus 0.13B).

## 7. Off-chain library

Measured on an Apple M2 Max with Node 24.10.0 on 2026-10-06.

| Operation | Result |
|---|---|
| One Poseidon255 `h2` call | about 0.17 ms |
| Append 200 leaves, then read the root once | 226 hash calls |
| Set one leaf, then read the root | 32 hash calls |
