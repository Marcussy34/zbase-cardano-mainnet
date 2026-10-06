# Measurements taken on 2026-10-06

These numbers were measured for this project before any product code existed.
They are the evidence behind the main design decisions in [SPEC.md](../SPEC.md).

## 1. Existing code, measured with Aiken 1.1.19

| What | CPU steps | Memory | Test |
|---|---|---|---|
| Groth16 verify, Cardano Foundation code, inputs `[1, 48]` | 2,139,202,479 | 45,891 | `t_single_verify_still_works` |
| Groth16 verify, ak-381, 4 public inputs | 2,399,758,405 | 45,781 | `snark_1` |
| One Poseidon hash on-chain | 1,271,273,371 | 3,696,424 | `poseidon_hashes_one_two` |
| Foundation pool test, two spends at depth 3 | 30,661,577,061 | 89,169,983 | `t_state_transition_two_escapes_depth3` |
| Nullifier insert into a small trie | 9,726,776 | 31,609 | `insert_nullifier` |

Limits for comparison: 10,000,000,000 CPU and 16,500,000 memory per transaction on mainnet.

What these show:

- One proof check uses about a fifth to a quarter of a transaction.
- One Poseidon hash on-chain uses 13% of the CPU limit and 22% of the memory limit.
- The Foundation pool test is 3 times over the CPU limit and 5 times over the memory limit. Its tests pass only because the test runner sets no limit.

### How to reproduce

1. Download Aiken 1.1.19 or later from the `aiken-lang/aiken` releases page.
2. Clone the Foundation repo: `git clone --depth 1 https://github.com/cardano-foundation/bls` (commit `d0128d8` was used).
3. Run `aiken check bls/aiken/f5/pool-contract`. Each test prints its CPU and memory.
4. Clone Semaphore: `git clone --depth 1 https://github.com/Modulo-P/Cardano-Semaphore` (commit `017aed8` was used).
5. Run `aiken check Cardano-Semaphore`. One upstream test, `spend_signal_semaphore_1`, fails at that commit. The two tests used here pass.

Raw output: [data/aiken-check-cf-f5-pool.json](./data/aiken-check-cf-f5-pool.json) and [data/aiken-check-cardano-semaphore.json](./data/aiken-check-cardano-semaphore.json).

## 2. Live protocol parameters

Read from `https://api.koios.rest/api/v1/epoch_params?limit=1` at mainnet epoch 659.
Snapshot: [data/koios-mainnet-epoch-params.json](./data/koios-mainnet-epoch-params.json).

## 3. Code reading findings

- The Foundation batch verifier derives its random factor from the proofs and the key, not from the public inputs. That looks unsound for a pool, because inputs could be shifted between batched proofs. No exploit was built. This project does not use batch verification.
- The Foundation `privacy_pool` circuit does not range-check its public `fee`, and the pool contract does not bound it. This project fixes the total withdrawn amount in the proof and range-checks it on-chain.
- The stock TypeScript x402 facilitator accepts any transaction with at least one key or script witness that conserves value and pays the recipient. Source files are listed in the x402 digest.

## 4. Spike results, measured with Aiken 1.1.24

The spike code is in [spikes/](./spikes/). Both spikes were rerun by the lead after the workers finished.

### 4.1 The proof pipeline works

A snarkjs Groth16 proof on curve `bls12-381` was converted to compressed bytes and verified with Plutus builtins.

| Test | Result | CPU steps | Memory |
|---|---|---|---|
| Valid proof, 2 public inputs | Valid | 2,402,366,517 | 81,457 |
| Valid proof, one input is 0 and is skipped | Valid | 2,271,854,186 | 80,403 |
| Proof with one point replaced | Invalid | 2,404,114,076 | 86,642 |
| Wrong public input | Invalid | 2,402,955,290 | 83,822 |
| Input `x + r`, with the range check | Invalid | 2,648,658 | 11,966 |
| Input `x + r`, without the range check | Valid | 2,399,561,250 | 70,924 |
| Valid proof through the multi-scalar builtin | Valid | 2,819,520,567 | 111,819 |

What these show:

- Skipping a zero input saves 130,512,331 CPU. That confirms the cost of one public input.
- Without the range check, an aliased input verifies. Rule V1 in the Spec is required.
- The multi-scalar builtin was 417M CPU slower than the loop for this circuit.

### 4.2 Curve points in data structures cost extra

| Test | CPU steps |
|---|---|
| Uncompress a G1 point and use it | 53,550,230 |
| Uncompress a G1 point, wrap it in `Option`, unwrap it, use it | 110,701,463 |
| Uncompress a G2 point and use it | 75,759,594 |
| Uncompress a G2 point, wrap it in `Option`, unwrap it, use it | 155,108,418 |

Aiken stores a curve point inside a data structure as compressed bytes.
One wrap costs about 57M CPU for G1 and 79M CPU for G2.

The spike verifier returns points in `Option` four times. That explains why it measures 2.40B CPU where the unit costs predict about 2.15B.
The product verifier must avoid such wraps (Spec rule V6).

### 4.3 Unit costs match the live cost model

| Operation | Measured | Live cost model |
|---|---|---|
| One Miller loop | about 254.1M | 254,006,273 |
| One Miller loop plus final verify | about 587.6M | 587,855,987 |

Aiken 1.1.19 and 1.1.24 gave identical numbers for these tests.

### 4.4 Library compatibility

`aiken-lang/merkle-patricia-forestry` 2.1.0 compiled and passed its insert test with Aiken 1.1.24 and each of these stdlib versions: v2.2.1, v3.1.0, v4.0.0.
An insert into an empty trie cost 5,500,046 CPU and 21,818 memory.

### 4.5 Poseidon255 constraint counts

Measured with circom 2.2.3.

| Template | Constraints at `--O2` | Non-linear at the default level | Linear at the default level |
|---|---|---|---|
| `Poseidon255(1)` | 213 | 216 | 256 |
| `Poseidon255(2)` | 237 | 240 | 384 |
| `Poseidon255(3)` | 261 | 264 | 512 |

The default level keeps linear constraints. Compile with `--O2`, or each hash costs about 2.6 times more constraints.

### 4.6 Pitfalls found by the spikes

1. snarkjs writes each G2 coordinate as `[c0, c1]`. The compressed bytes need `c1` first. Bytes in the snarkjs order were rejected.
2. A snarkjs setup is not reproducible, even with fixed entropy text. Keep the generated keys. Do not expect to rebuild them.
3. `@noble/curves` version 2 needs the import path `@noble/curves/bls12-381.js`. Its `multiply(0n)` throws.
4. The JavaScript Poseidon library does not range-check inputs. `H1(r)` equals `H1(0)`.
5. A script that calls snarkjs must call `process.exit` at the end, or it hangs on worker threads.
6. `circom2` needs a real `node_modules` folder in the working directory. A symlink failed.
7. The multi-scalar builtin ignores extra list elements. It also reduces scalars modulo `r`.
8. The trie library is imported as `aiken/merkle_patricia_forestry`. `mpf.empty` is a constant, not a function.
9. `aiken check` prints JSON to standard output when it is not a terminal. Its shape differs from the published schema.
10. In JavaScript, use division for tree indexes above 2^31. The `>>` operator is a signed 32-bit shift.
11. `snarkjs.wtns.check` needs a logger object. Without one it crashes when a witness is wrong.
