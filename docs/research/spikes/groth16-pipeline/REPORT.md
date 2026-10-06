# Spike report: circom (BLS12-381) to snarkjs Groth16 to Aiken Plutus V3

Date: 2026-10-06. Machine: Darwin arm64. Every number and claim below comes
from a command run in this directory, unless it is marked "not measured".

## Results at a glance

- The pipeline works end to end. A snarkjs Groth16 proof over BLS12-381,
  converted to Zcash compressed bytes, verifies on the Aiken (Plutus V3)
  side with the BLS12-381 builtins.
- `bash verify.sh` prints 34 `PASS` lines, no `FAIL`, and exits 0.
- Aliased input control: without rule V1, the input `d + r` verifies as
  `True`. With V1 it returns `False` (test `aliased_input_control_without_v1`
  and test `aliased_input_fails`).
- Stdlib question: MPF v2.1.0 with Aiken v1.1.24 compiles and passes with
  all three stdlib versions tried (v2.2.1, v3.1.0, v4.0.0). No version
  failed, so there is no error text to record. Costs are identical across
  the three.
- The MSM path costs more than the loop path for this 2-input circuit:
  +417,154,050 CPU (+17.36%) on proof 1.

## Tool versions (as reported by the tools)

| Tool | Version | How it was checked |
|---|---|---|
| Node | v24.10.0 | `node --version` |
| npm | 11.6.1 | `npm --version` |
| circom2 (npm) | 0.2.23, bundles circom compiler 2.2.3 | `npx circom2 --version` |
| snarkjs | 0.7.6 | `npx snarkjs --version` |
| @noble/curves | 2.4.0 | `node_modules/@noble/curves/package.json` |
| @noble/hashes | 2.4.0 (transitive dependency of @noble/curves) | `node_modules/@noble/hashes/package.json` |
| Aiken | v1.1.24+bacbeb3 | `tools/aiken-1.1.24/aiken-aarch64-apple-darwin/aiken --version` |

The Aiken archive sha256 is
`5faa52fb466686ad511c00e1b85c0d3eb0620b13192b064e116f80892e419676`. It
matched the published `.sha256` file (`shasum -a 256`).

## Layout

| Path | Purpose |
|---|---|
| `circuit/mul.circom` | `d <== a * b + c`, `a` and `b` private, `c` public. Public signals are `[d, c]`. |
| `scripts/prove.sh` | Compile, powers of tau, Groth16 setup, one zkey contribution, export the key, two proofs, `snarkjs groth16 verify`. |
| `scripts/compress.mjs` | snarkjs JSON to Zcash compressed bytes with self-checks. Writes `out/vectors.json`. |
| `scripts/gen_aiken_test.mjs` | Generates `aiken/lib/spike/groth16_test.ak` from `out/vectors.json`. |
| `aiken/lib/spike/groth16.ak` | Verifier: `verify` (loop path), `verify_msm` (MSM path), `verify_unchecked_range` (control only). |
| `scripts/gen_mpf_test.mjs` | Generates `aiken-mpf/lib/spike/mpf_test.ak`. The expected trie root comes from @noble/hashes. |
| `aiken-mpf/` | MPF v2.1.0 project (stdlib v2.2.1 pinned). |
| `scripts/mpf_matrix.sh` | Builds a copy of `aiken-mpf` (plus `groth16.ak`) per stdlib version. |
| `verify.sh` | Reruns all checks and prints `PASS <name>` or `FAIL <name>`. |
| `out/` | `vectors.json`, `aiken-check.json`, `mpf-stdlib-<ver>.json` and `.stderr.txt`, `verify.log`. |
| `tools/` | Aiken binary and download, plus `aiken-home` (Aiken package cache, see pitfall 14). |

## Exact commands

Setup (run once):

```sh
npm install --save-exact circom2@0.2.23 snarkjs@0.7.6 @noble/curves@2.4.0
cd tools/dl
gh release download v1.1.24 -R aiken-lang/aiken -p 'aiken-aarch64-apple-darwin.tar.gz' -p 'aiken-aarch64-apple-darwin.tar.gz.sha256'
shasum -a 256 aiken-aarch64-apple-darwin.tar.gz   # compared with the .sha256 file
tar -xzf aiken-aarch64-apple-darwin.tar.gz -C ../aiken-1.1.24
```

`scripts/prove.sh` runs these commands (all paths under `build/`):

```sh
npx circom2 circuit/mul.circom --r1cs --wasm --sym --prime bls12381 -o build
snarkjs powersoftau new bls12-381 8 build/pot8_0000.ptau
snarkjs powersoftau contribute build/pot8_0000.ptau build/pot8_0001.ptau --name="spike ptau contribution" -e="spike-ptau-entropy-not-secret"
snarkjs powersoftau prepare phase2 build/pot8_0001.ptau build/pot8_final.ptau
snarkjs groth16 setup build/mul.r1cs build/pot8_final.ptau build/mul_0000.zkey
snarkjs zkey contribute build/mul_0000.zkey build/mul_final.zkey --name="spike zkey contribution" -e="spike-zkey-entropy-not-secret"
snarkjs zkey export verificationkey build/mul_final.zkey build/verification_key.json
snarkjs wtns calculate build/mul_js/mul.wasm build/proofN/input.json build/proofN/witness.wtns
snarkjs groth16 prove build/mul_final.zkey build/proofN/witness.wtns build/proofN/proof.json build/proofN/public.json
snarkjs groth16 verify build/verification_key.json build/proofN/public.json build/proofN/proof.json
```

Then:

```sh
node scripts/compress.mjs
node scripts/gen_aiken_test.mjs
cd aiken && HOME=../tools/aiken-home ../tools/aiken-1.1.24/aiken-aarch64-apple-darwin/aiken check > ../out/aiken-check.json
node scripts/gen_mpf_test.mjs
bash scripts/mpf_matrix.sh
bash verify.sh            # reuses build/ artifacts
bash verify.sh --force    # rebuilds the setup and proofs from scratch
```

`bash verify.sh --force` was also run once in a temporary copy of this
directory. All 34 checks passed there with a brand new key and proofs. The
copy was deleted afterwards.

## Circuit facts (`snarkjs r1cs info`)

Curve bls12-381, 5 wires, 1 constraint, 2 private inputs, 1 public input,
1 output. `verification_key.json` has `nPublic: 2` and 3 IC points.

## Test vectors (`out/vectors.json`)

These hex values belong to the current `build/` key. A new setup changes
them (pitfall 3). All points are Zcash compressed.

| Name | Hex |
|---|---|
| vk alpha_g1 | `91d2818338afc909d485a8d59597eba6fbdab091bd686ef52005e569d256e8fd3077c509e226bd16ea1764f67d0fd999` |
| vk beta_g2 | `86425dbce28f2bbe8b7fdf5d7b9eaa8f435155643d505a68803d11d92bde56e3df9d3ef3d27f49b23468d74ca60909fa190a478692ae34909355ddf92a83109f900b1384c617b7fe22e9a5debeb88805545bc0660a3a6ab078b0e2b7794f5b9d` |
| vk gamma_g2 | `93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8` |
| vk delta_g2 | `8ab01564d7dc3d4b20872f68a9cfb0f4c4113d400771554cebda3525daefde95ed8b19eef544a5e0b93fec0c20e7f0f8146ae94f8a70dc48b676208a4fba786fbe43cbeb1ffa20649dfd09b3c0b850a08123ffdc17ee7be89696835f03485601` |
| vk ic[0] | `a8bc06cac776073ae33eecef4e6719a88dada0cbbf00c22ebcbda61d4d8811e749792e053651f7d0ea5ef3b80234b07d` |
| vk ic[1] | `97f780c0ddc2cb146123b6d1a5e9c5bd21dd385610feb41dd0079cfbaa261f37e6fad1786938b42e8accc0ce3e01b91c` |
| vk ic[2] | `99f1e0e23f9693023bb97bc1bb7461f0739cc5dd02d0bf48ea62fcec61957f82e47f85b46f05752f1958ee47e6554d01` |
| proof1 (a=3, b=4, c=5; signals `[17, 5]`) A | `840679528d4326d7cc856bf3d6fc7ebadd18a5aa6b1a233e93a06dc7a8edefc059e8d775872d5f29f5159aea169fc4c8` |
| proof1 B | `97c5a1af533150935877339f5d0376ad86bfb37f3e3f6ddc9d74b440eeff7f0ffb04e56a3b04d8ae5b2d24247828dcdc0fad6f141c7d684778caca6f0af760da0193024af930d31708d799bff19ed8129b32fe58f1eb254a0dd6d3c2e67bc86f` |
| proof1 C | `b0ca2896c7e9adaafb40259a20d4a8fba7859693491e421d89831f63535cd00316984737c61d4b43cf061cef5a9410b2` |
| proof2 (a=6, b=7, c=0; signals `[42, 0]`) A | `90f19e65a20af7555aa37299913cd9d060b53014a112c208b7374d1a3502d2473e4e2ad7a9c7597f9d7a6fadb1f61145` |
| proof2 B | `a3fd291b3e6f9d7b722e1ad37019e804cbbd822c7741976959f8e19fa0fbe90f598cb7bc65378ac89ede18a89c9785e6078b203f075ddfeb8123133de9a8294d92f929d505ef10be7caf482d91cac0859cefbca4c07b61c498507d2cf52cb64b` |
| proof2 C | `8dda982b272c2275d3ec3dd0692dc9a3162bdeabce09369f24820b980f87d8dd32c4634b61dd0ad5c9532c740528d133` |

`compress.mjs` self-checks every point before it writes the file:

- noble `fromAffine` plus `assertValidity` (on the curve and in the subgroup).
- The noble bytes equal those of an independent reference encoder written
  from the Zcash flag rules.
- Decompressing with noble returns the original affine coordinates.
- The G1 and G2 generators encode to the known Zcash vectors.
- A noble pairing check of both proofs passes, independent of snarkjs.
- Each G2 point with swapped `c0`/`c1` order is rejected (pitfall 1).

## PASS or FAIL table (`bash verify.sh`, exit 0)

| Check | Result |
|---|---|
| tool_aiken_v1.1.24, tool_circom2_0.2.23, tool_snarkjs_0.7.6, tool_noble_curves_2.4.0 | PASS |
| prove_sh | PASS |
| snarkjs_verify_proof1, snarkjs_verify_proof2 | PASS |
| public_signals_proof1_17_5, public_signals_proof2_42_0 | PASS |
| compress_selfchecks, vectors_json_exists | PASS |
| gen_aiken_test, aiken_fmt_check, aiken_check_exit_0, aiken_check_json_exists | PASS |
| aiken_test_<name> for all 15 Aiken tests below | PASS |
| gen_mpf_test | PASS |
| mpf_stdlib_v2.2.1_compiles_and_passes | PASS |
| mpf_stdlib_v3.1.0_compiles_and_passes | PASS |
| mpf_stdlib_v4.0.0_compiles_and_passes | PASS |

Negative control for the harness: `snarkjs groth16 verify` with public
signals `["18","5"]` printed `Invalid proof` and exited 1. The test lookup in
`verify.sh` exits 1 for a missing test name.

## Aiken tests: CPU and memory (`out/aiken-check.json`)

Aiken v1.1.24, default trace level (verbose). One rerun with `-t silent`
(made before `msm_ignores_extra_elements` existed) gave identical numbers
for every other test except `msm_path_matches` and
`msm_reduces_scalars_mod_r`. Those two use `expect` and changed slightly. Each test passes only when it behaves as stated,
because it asserts its own polarity (for example `!verify(...)`).

| Test | Expected behaviour | CPU | Mem |
|---|---|---|---|
| `valid_proof_1` | True | 2,402,366,517 | 81,457 |
| `valid_proof_2` (zero public input) | True | 2,271,854,186 | 80,403 |
| `tampered_proof_fails` (C := A) | False | 2,404,114,076 | 86,642 |
| `wrong_public_input_fails` (d + 1) | False | 2,402,955,290 | 83,822 |
| `aliased_input_fails` (d + r, with V1) | False | 2,648,658 | 11,966 |
| `aliased_input_control_without_v1` (d + r, no V1) | **True** | 2,399,561,250 | 70,924 |
| `msm_path_matches` (same vk_x and verdict, both proofs) | True | 12,252,343,657 | 526,911 |
| extra: `valid_proof_1_msm` | True | 2,819,520,567 | 111,819 |
| extra: `valid_proof_2_msm` | True | 2,683,395,546 | 102,529 |
| extra: `infinity_proof_point_fails` (V2) | False | 329,570,061 | 48,125 |
| extra: `wrong_length_proof_point_fails` (V2, 47-byte C) | False | 475,725,306 | 70,279 |
| extra: `invalid_point_bytes_error` (`fail` test) | script error | 381,171,269 | 41,976 |
| extra: `input_count_mismatch_fails` (V3) | False | 190,583,420 | 27,310 |
| extra: `msm_reduces_scalars_mod_r` | True | 865,897,283 | 28,455 |
| extra: `msm_ignores_extra_elements` | True | 1,000,192,810 | 28,763 |

The costs include building the key and proof records inside the test. They
do not include datum, redeemer or script context decoding, so they are not
a full validator budget. Mainnet transaction limits were not checked here.
`valid_proof_1` and `valid_proof_2` had the same costs after a fresh setup
with different points.

Derived from the table:

- V5 (skip a zero input) saves 130,512,331 CPU and 1,054 mem
  (`valid_proof_1` minus `valid_proof_2`). That is about the cost of one
  IC term: one uncompress, one scalar multiplication and one addition.
- The MSM path costs more for 2 inputs. Proof 1: +417,154,050 CPU (+17.36%)
  and +30,362 mem. Proof 2: +411,541,360 CPU (+18.11%) and +22,126 mem.
  The MSM path includes one more list element (IC[0] with scalar 1), so it
  needs no separate addition. Where the break-even input count lies was not
  measured.
- V1 rejects an aliased input for 2,648,658 CPU, before any curve operation.
- `infinity_proof_point_fails` costs 329,570,061 CPU because vk_x is
  computed before the proof points are decoded. Decoding the proof points
  first would make that rejection cheaper. This order was not changed.
- The nested `when` in `pairing_check` was measured against one `when` on a
  4-tuple. The tuple form cost 2,403,825,554 CPU and 85,509 mem on
  `valid_proof_1`, so the nested form is cheaper by 1,459,037 CPU.

## Verifier rules as implemented (`aiken/lib/spike/groth16.ak`)

- V1: `inputs_in_field` runs first in `verify` and `verify_msm`. `&&`
  short-circuits, so an out-of-range input never reaches a curve builtin.
- V2: applies to proof points only (A, C 48 bytes, B 96 bytes). The
  verifier returns `False` for a wrong length, the infinity encoding, or a
  failed `compress(uncompress(p)) == p`. Bytes that are not a valid point
  make the uncompress builtin fail the script. The observed trace was
  `blst error BLST_POINT_NOT_IN_GROUP`. Verification key points are
  trusted and are uncompressed without these checks.
- V3: checked while walking the inputs and the IC list together. The MSM
  path needs it, because the MSM builtin silently ignores the extra
  elements of the longer list (`msm_ignores_extra_elements`).
- V4: `final_verify(ml(A, B), ml(alpha, beta) * ml(vk_x, gamma) * ml(C, delta))`,
  so four Miller loops, two multiplications and one final verify.
- V5: a zero input skips the uncompress and the scalar multiplication, on
  both paths.
- V6: `compute_vk_x_msm` calls `bls12_381_g1_multi_scalar_mul` once with
  `[1, x_i..]` and `[IC[0], IC[i+1]..]`.
- The control `verify_unchecked_range` is exactly `verify` without V1.

Not shown: I did not find or build a byte string that the uncompress
builtin accepts but that fails the canonical round trip. So no test shows
that check rejecting something; it is kept as a defensive check, as the
brief asks.

## Stdlib compatibility (Part 4)

MPF tag `v2.1.0` (commit `4fbc621`, the same commit as tag `2.1.0`) has
`aiken.toml` at the repository root and declares `aiken-lang/stdlib`
version `v2`. The test project `aiken-mpf` has two tests. The first inserts
a 32-byte key into an empty trie (`mpf.from_root` of 32 zero bytes, then
`mpf.insert` with an empty proof). It compares the new root with a root
computed off-chain by @noble/hashes. The second runs a BLS12-381 pairing
check through the builtins. `scripts/mpf_matrix.sh` also copies
`groth16.ak` into each build, so the verifier and MPF compile together.

| stdlib | aiken check exit | Tests | insert CPU | insert mem | BLS test CPU | BLS test mem |
|---|---|---|---|---|---|---|
| v2.2.1 | 0 | 2/2 pass | 5,500,046 | 21,818 | 1,204,694,691 | 3,453 |
| v3.1.0 | 0 | 2/2 pass | 5,500,046 | 21,818 | 1,204,694,691 | 3,453 |
| v4.0.0 | 0 | 2/2 pass | 5,500,046 | 21,818 | 1,204,694,691 | 3,453 |

There is no error text, because no version failed. Each build printed
`Summary 2 checks, 0 errors, 0 warnings`. The answer is: with Aiken
v1.1.24, MPF v2.1.0 does not need one specific stdlib among these three.
`aiken-mpf/aiken.toml` pins v2.2.1, the commit MPF itself resolves.

Why this works:

- Aiken did not resolve MPF's own dependencies. The generated `aiken.lock`
  lists MPF with `requirements = []`, and `aiken-lang/fuzz` was never
  downloaded. The root project's stdlib version is the only one used.
- MPF's library modules use only `aiken/primitive/bytearray` (`at`,
  `concat`, `drop`, `length`, `push`) from stdlib.
- MPF's `*.tests.ak` modules import `aiken/fuzz`, which was not
  downloaded, yet the build passed. So Aiken did not compile the test
  modules of a dependency.

## Pitfalls hit or confirmed

1. G2 coordinate order: snarkjs JSON writes each Fp2 element as
   `[c0, c1]`, but the Zcash bytes are `c1 || c0`. noble handles this
   internally (`Fp2.fromBigTuple([c0, c1])`, then `toBytes(true)`). Bytes
   written in the snarkjs order were rejected for all five G2 points in
   this run. Two failed with `Cannot find square root` (not on the curve)
   and three with `not in prime-order subgroup`.
2. Flag bits in byte 0: `0x80` compressed, `0x40` infinity, `0x20` sign.
   The sign bit is set when y is the larger root. For G2, compare `y.c1`
   first and fall back to `y.c0` only when `c1 == 0`. The reference
   encoder in `compress.mjs` matched noble on all 10 points.
3. snarkjs setup is not reproducible, even with fixed `-e` entropy.
   `getRandomRng` in `node_modules/snarkjs/build/main.cjs` hashes
   `getRandomBytes(64)` together with the entropy string. A fresh setup
   produced a different alpha. Groth16 proofs are randomized too. So
   `prove.sh` and `verify.sh` reuse `build/` unless `--force` is given.
4. snarkjs sets gamma to the G2 generator: `vk.gamma_g2` equals the
   generator bytes `93e02b60...bdb8`, in both setups that were run.
5. Montgomery form: snarkjs JSON holds plain decimal integers in normal
   form, not Montgomery form, and projective with `z = 1`. noble accepted
   them directly, and `assertValidity` passed.
6. noble v2 API: import `@noble/curves/bls12-381.js` (with `.js`).
   Importing `@noble/curves/package.json` fails with
   `ERR_PACKAGE_PATH_NOT_EXPORTED`. `Point.multiply(0n)` throws
   `invalid scalar: out of range`, so zero scalars need a guard.
7. Aliasing: the scalar multiplication builtin and the MSM builtin both
   reduce scalars modulo r. That is why `d + r` verifies without V1, and why
   V1 is needed on both paths (`msm_reduces_scalars_mod_r`).
8. The MSM builtin ignores extra list elements instead of failing, so V3
   must be explicit (`msm_ignores_extra_elements`). The Aiken v1.1.24
   CHANGELOG also lists a fix for MSM argument conversion (issue #1378), so
   older Aiken versions may compile MSM calls wrongly. Older versions were
   not tested.
9. Aiken builtin names, as found in the v1.1.24 binary (argument order
   confirmed by the code compiling and the tests passing):
   `bls12_381_g1_uncompress`, `bls12_381_g1_compress`,
   `bls12_381_g1_scalar_mul(Int, G1Element)`, `bls12_381_g1_add`,
   `bls12_381_g1_equal`, `bls12_381_g1_multi_scalar_mul(List<Int>, List<G1Element>)`,
   `bls12_381_miller_loop`, `bls12_381_mul_miller_loop_result` and
   `bls12_381_final_verify`. `aiken/builtin` needs no stdlib, so the
   `aiken/` project has no dependencies.
10. `aiken check` JSON output: stdout is JSON when it is not a terminal, and
    compiler logs go to stderr. The JSON does not match
    `aiken check --show-json-schema`. The schema wraps everything in
    `"command[check]"` and names the per-module array `"test"`. The real
    output has `seed`, `summary` and `modules` at the top level and names
    the array `"tests"`. The `traces` field (seen on the `fail` test) is
    not in the schema. A passing `fail` test shows
    `"on_failure": "succeed_eventually"`.
11. `aiken fmt --check` rejected the first layout of both Aiken files. The
    generator template now emits the layout the formatter wants, and
    `verify.sh` checks it.
12. MPF module path: the file is `lib/aiken/merkle-patricia-forestry.ak`,
    but the import is `use aiken/merkle_patricia_forestry` (hyphens become
    underscores).
13. MPF docs drift: in v2.x `mpf.empty` is a constant, but its doc comment
    shows `mpf.empty()`. The README install line still says
    `--version 2.0.1`. stdlib tag v2.2.1 has `version = "2.2.0"` in its own
    `aiken.toml`. On GitHub, tag `v2` of stdlib points to the same commit as
    `v2.2.1`, and tag `v3` points to the same commit as `v3.1.0`.
14. Aiken caches downloaded packages under `$HOME/Library/Caches/aiken` on
    macOS. All Aiken runs here set `HOME=tools/aiken-home`, so the cache
    stays inside the work directory. `aiken new` with v1.1.24 defaults to
    stdlib v4.0.0 and prints a hint to update the stdlib version.
15. npm reported 3 high severity advisories after install: `underscore`
    (recursion DoS), pulled in through `jsonpath` and `bfj` from snarkjs.
    These were not investigated further; this is a throwaway spike.
