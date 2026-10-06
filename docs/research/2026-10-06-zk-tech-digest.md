# Research digest: zero-knowledge tooling on Cardano

| Field | Value |
|---|---|
| Date | 2026-10-06 |
| Method | A research agent read live pages and cloned repos. Nothing was executed from the clones. |
| Status | Reference material. The Spec is the source of truth. |

Every fact lists its source. "Derived" means computed from sourced numbers. "Unverified" means no source was found.

## 1. Groth16 verifiers and their measured costs

All rows are Plutus V3 over BLS12-381.

| Source | Public inputs | CPU steps | Memory | Context |
|---|---|---|---|---|
| `IntersectMBO/plutus` benchmark | 1 | 1,996,692,293 | 10,203 | `plutus-benchmark/bls12-381-costs/test/9.6/bls12-381-costs.golden`, script 773 bytes |
| `cardano-foundation/bls` | 1, plus the constant wire | 1,998,214,009 | 15,293 | `aiken/groth16/README.md` |
| `elRaulito/ZK-from-zero-on-Cardano` | 1 | 2,005,373,690 | not given | README, password example |
| `cardano-scaling/snarkjs-circom-aiken` | 2 | 2.25B | 37.2K | README |
| TrustLevel unlock | 3 | 2,321,320,097 | 194,230 | Preprod transaction, total fee 0.42706 ADA |
| `ODATANO/DAYZERO` | 4 | 2.71B | 173K | Preview transaction, script 1,797 bytes with the key applied |
| TrustLevel borrow | 5 | 2,655,829,084 | 387,692 | Preprod transaction, total fee 0.561737 ADA, script share 0.213856 ADA |
| TrustLevel repay | two proofs | 5,083,199,002 | 508,943 | Preprod transaction, total fee 0.754878 ADA |
| `blocksmithy/oakshield-aiken` (gnark proof with commitment) | 5 | 4.54B | 0.35M | README |

TrustLevel transactions on preprod (cardanoscan):

- Borrow: `8bc3d205f67eaa6d965e2f59e24210abba4251bbba2ae31e96f13507b5fc45b9`
- Repay: `f8756c92addb71fae26c6bdf160be3028266825199b5acf53d202bd89d316a38`
- Unlock: `43f4339ea8aac1d34bb14581e02aaabcc3f2e23ce15dd2f1c30118a805f02521`

Notes on each verifier:

- **`Modulo-P/ak-381`**: last commit 2025-06-10. `groth_verify(vk, proof, public)` in `lib/ak-381/groth16.ak`. It needs a converter (`conversion/index.js`). It has no range check on inputs and no license file.
- **`cardano-scaling/snarkjs-circom-aiken`**: last commit 2026-06-07. It relies on snarkjs pull request 625, which is not merged. snarkjs 0.7.6 lacks those export commands.
- **`cardano-foundation/bls`**: last commit 2026-09-30. Generic key, own Rust prover, batch verifier. Apache-2.0.
- **`ODATANO/DAYZERO`**: last commit 2026-10-06. The most defensive verifier read: it checks `0 <= x < r`, canonical points, non-infinity, and exact lengths. Apache-2.0.
- **`TrustLevel/ZK-Defi-Protocol`**: last commit 2026-09-17. Uses ak-381 0.1.1 with stock circom and snarkjs. Live on preprod.
- **`input-output-hk/plutus-groth16-wrapper`**: wraps BN254 proofs into BLS12-381 proofs. Its PLONK path verifies at 4.82B CPU.
- **`zkFold/zkfold-cardano`**: PLONK only. `plonkVerifier` costs 5,476,475,230 CPU.

### Cost per extra public input

Derived from the live mainnet cost model (Koios, epoch 659):

| Builtin | CPU |
|---|---|
| G1 uncompress | 52,948,122 |
| G1 scalar multiplication | 76,433,006, plus 8,868 per 8-byte word of the scalar |
| G1 add | 962,335 |
| Miller loop | 254,006,273 |
| Final verify | 333,849,714 |
| G2 uncompress | 74,698,472 |
| G1 multi-scalar multiplication | 321,837,444, plus 25,087,669 per scalar |

- One extra public input costs about 130.4M CPU: one uncompress, one scalar multiplication, one add.
- By raw builtin prices, the multi-scalar builtin beats the loop from 7 inputs upward. In Aiken 1.1.24 it was slower in practice. See the measurements file.
- The Cardano Foundation README estimates 50M per input. The cost model says 130.4M. Trust the cost model.

## 2. Protocol limits

Source: Koios `epoch_params`, mainnet epoch 659 and preprod epoch 317.

| Parameter | Mainnet | Preprod |
|---|---|---|
| Protocol version | 11.0 | 11.0 |
| CPU per transaction | 10,000,000,000 | 10,000,000,000 |
| Memory per transaction | 16,500,000 | 17,500,000 |
| CPU per block | 20,000,000,000 | 20,000,000,000 |
| Memory per block | 72,000,000 | 77,500,000 |
| Transaction size | 16,384 bytes | 16,384 bytes |
| Fee | 155,381 + 44 per byte | same |
| Script prices | 0.0000721 per step, 0.0577 per memory unit | same |
| Reference script fee | 15 lovelace per byte | same |
| Minimum ADA | 4,310 lovelace per byte | same |
| Collateral | 150%, at most 3 inputs | same |

- Mainnet memory limits rose to 16.5M and 72M at epoch 614 (2026-02-18).
- Reference script limits are ledger constants: 200 KiB per transaction, 1 MiB per block, price times 1.2 per 25,600-byte tier. Source: `cardano-ledger`, Conway `PParams.hs`.

## 3. Builtins after Chang

Source: `plutus-ledger-api`, `Common/Versions.hs`.

| Hard fork | Protocol version | Added |
|---|---|---|
| Chang | 9 | Plutus V3, the 17 BLS12-381 builtins, keccak_256, blake2b_224, integer and bytestring conversions |
| Plomin | 10 | Bitwise builtins, ripemd_160 |
| van Rossem | 11 | `expModInteger`, `dropList`, array builtins, BLS12-381 multi-scalar multiplication for G1 and G2, Value builtins |

- van Rossem is live on mainnet since 2026-07-18 (epoch 644) and on preprod since 2026-06-10.
- Aiken 1.1.23 parses the version 11 cost models. Aiken 1.1.24 fixes the multi-scalar multiplication builtins, which failed at runtime before (issue 1378).
- Next is Dijkstra, version 12, with Plutus V4.

### Poseidon builtin proposal

- `cardano-foundation/CIPs` pull request 1263, "Poseidon Permutation Built-in for Plutus". Open, not merged. Created 2026-09-07.
- It proposes one builtin for the Poseidon permutation, with a registry of instances.
- Registered: index 0 is midnight-zk (width 3, 60 partial rounds). Index 1 is the circom port by jmagan (width 3, 56 partial rounds).
- The width 4 circom instance is a candidate only.
- Proposed price: about 24M CPU per call.
- It needs an audit and a hard fork. It is not in plutus master.
- No proposal exists for BN254 pairing builtins.

## 4. Poseidon on Cardano

- The only Aiken implementation found is `aiken/f5/pool-contract/lib/f5/poseidon.ak` in `cardano-foundation/bls`.
- No published measurement of a full hash existed. This project measured that code at 1.27B CPU per hash (see the measurements file).
- An estimate from measured primitives gives 0.6B CPU and 1.43M memory per hash as a lower bound. Source: `elRaulito/ZK-from-zero-on-Cardano`, `eBook/sections/part8/tornado.tex`.
- `expModInteger` does not make the S-box cheaper.

Parameter sets in use for the BLS12-381 scalar field:

| Set | Partial rounds at width 3 | Used by |
|---|---|---|
| `jmagan/poseidon-bls12381-circom` | 56 | TrustLevel, Pulse, this project |
| ZeroJ `PoseidonParamsBLS12_381T3` | 57 | `cardano-foundation/bls`, DAYZERO |
| midnight-zk | 60 | Midnight |
| circomlib constants compiled with `--prime bls12381` | BN254 constants | Janus Wallet, the eBook. No security analysis found |

These sets give different hash values. Do not mix them.

Tooling:

- snarkjs supports `bn128` and `bls12-381`. Latest release is 0.7.6 (2026-01-26).
- circom accepts `--prime bls12381`. Latest release is 2.2.3 (2025-10-27).
- `circomlibjs` implements Poseidon over BN254. It is a trap for Cardano work.

Point conversion to the 48-byte and 96-byte format:

- `Modulo-P/ak-381`: `conversion/index.js`.
- snarkjs pull request 625: `src/point_compress.js`. It notes that ffjavascript writes its own flag bits, so the three high bits must be cleared and rewritten with the Zcash flags.
- `elRaulito/ZK-from-zero-on-Cardano`: `compress_proof.js`, using `@noble/curves`.

## 5. Sets and trees on-chain

`aiken-lang/merkle-patricia-forestry`, on-chain version 2.1.0, license MPL-2.0, hash blake2b_256:

| Trie size | Proof size | Insert or delete | Membership | Non-membership |
|---|---|---|---|---|
| 10^4 | about 480 bytes | 90.1M CPU, 316.5K memory | 49.8M, 173.3K | 40.3M, 143.3K |
| 10^5 | about 620 bytes | 108.2M, 380.5K | 58.5M, 204.3K | 49.7M, 176.3K |
| 10^6 | about 760 bytes | 126.3M, 444.5K | 67.3M, 235.3K | 59M, 209.3K |
| 10^7 | about 900 bytes | 144.4M, 508.5K | 76M, 266.3K | 68.4M, 242.3K |
| 10^9 | about 1,180 bytes | 180.6M, 636.5K | 93.5M, 328.3K | 87.1M, 308.3K |

- The library adds about 2.5 KB of script.
- One root in one datum means every insert spends the same UTXO.
- `blocksmithy/oakshield-aiken` ships a sharded nullifier set keyed by the first nullifier byte.
- Linked lists (Anastasia Labs `aiken-design-patterns` 1.9.0) spread contention, but each element is a permanent UTXO with minimum ADA.
- Chained transactions are valid on Cardano. One relayer can advance a state UTXO several times per block.
- TrustLevel proves its Merkle append in-circuit (`circuits/append_proof.circom`, public signals `old_root, new_root, leaf, index`).

## 6. Warnings from this research

- Community verifiers pass public inputs as unchecked integers, and the scalar constructor reduces modulo the field prime. So `x` and `x + r` verify alike. Range-check before using a nullifier as a set key.
- One tutorial claims that minting a token named after the nullifier prevents double spends. That is wrong. A policy can mint the same name twice unless it checks more.

## 7. Not found

- An audited Aiken Groth16 verifier.
- A Groth16 shielded pool on Cardano mainnet.
- A merged snarkjs release with Cardano export commands.
- A security analysis of circomlib BN254 Poseidon constants over the BLS12-381 field.
