# Poseidon255 (BLS12-381) known-answer spike

Result: the circom template and the JavaScript library agree on every input tested.
`bash verify.sh` prints 26 PASS lines, no FAIL lines, and exits 0.
All numbers below come from that run.

## Versions

| Item | Version |
| --- | --- |
| node | v24.10.0 (npm 11.6.1, darwin) |
| circom2 (npm, WASI build of circom) | 0.2.23 |
| circom compiler reported by circom2 | 2.2.3 |
| snarkjs | 0.7.6 |
| poseidon-bls12381 (JavaScript) | 1.0.2 |
| poseidon-bls12381-circom | 1.0.0 |
| circomlib | 2.0.5 (installed as pinned; the circuits here do not use it) |

## Commands

Setup (run once in this directory):

1. `npm init -y`
2. `npm install --save-exact poseidon-bls12381@1.0.2 poseidon-bls12381-circom@1.0.0 circom2@0.2.23 snarkjs@0.7.6 circomlib@2.0.5`

Verification: `bash verify.sh`. It deletes `out/` and then runs:

1. A version check of the five installed packages.
2. `node vectors.mjs` (writes `out/poseidon-vectors.json`).
3. `npx circom2 <c>.circom --r1cs --wasm --sym --prime bls12381 -l node_modules -o out` for `c` in `kat`, `kat_h1`, `kat_h2`, `kat_h3`. Logs go to `out/compile_<c>.log`.
4. `node parity.mjs`. It uses the snarkjs API: `wtns.calculate`, `wtns.check` (witness against `out/kat.r1cs`) and `wtns.exportJson`. It writes `out/parity-results.json` and `out/constraints.json`.

Manual cross-checks that are not part of `verify.sh`:

- The snarkjs CLI gives the same witness as the API for input (1,2,3): `npx snarkjs wtns calculate out/kat_js/kat.wasm out/input_1_2_3.json w.wtns`, then `npx snarkjs wtns check out/kat.r1cs w.wtns` ("WITNESS IS CORRECT"), then `npx snarkjs wtns export json w.wtns w.json`. Witness entries 1..3 were identical to the API values.
- Fail-path test: a copy of the scripts with `poseidon2([b, a])` injected into the JS side gave `FAIL parity_1_2_3_h2  circom=2882...6810 js=3849...0024` and exit 1. An injected exception gave `FAIL vectors_script_crashed_...` and exit 1. The copy was deleted afterwards.
- `--O2` constraint counts: `npx circom2 <c>.circom --r1cs --O2 --prime bls12381 -l node_modules -o out/o2`.

## PASS/FAIL table (`bash verify.sh`, exit 0)

| Check | Result |
| --- | --- |
| pinned_package_versions | PASS |
| js_upstream_kat_h2_1_2 | PASS |
| js_input_encoding_bigint_string_hex_agree_number_rejected | PASS |
| js_no_range_check_input_r_aliases_0 | PASS |
| tree1_root_matches_path_walk_index_0 | PASS |
| tree1_siblings_index_0_are_zero_hashes | PASS |
| tree2_root_matches_path_walk_index_1 | PASS |
| tree2_root_matches_path_walk_index_0 | PASS |
| tree2_siblings_index_1_are_leaf0_then_zero_hashes | PASS |
| json_complete | PASS |
| compile_kat | PASS |
| compile_kat_h1 | PASS |
| compile_kat_h2 | PASS |
| compile_kat_h3 | PASS |
| witness_satisfies_r1cs_1_2_3 | PASS |
| parity_1_2_3_h1 | PASS |
| parity_1_2_3_h2 | PASS |
| parity_1_2_3_h3 | PASS |
| witness_satisfies_r1cs_rm1_rm1_5 | PASS |
| parity_rm1_rm1_5_h1 | PASS |
| parity_rm1_rm1_5_h2 | PASS |
| parity_rm1_rm1_5_h3 | PASS |
| circom_matches_json_vectors | PASS |
| negative_control_swapped_inputs_differ | PASS |
| constraints_nonlinear_match_sbox_formula | PASS |
| constraints_kat_equals_sum_of_single_templates | PASS |

What the less obvious checks mean:

- `js_upstream_kat_h2_1_2`: `poseidon2([1n, 2n])` equals `0x3fb8310b0e962b75bffec5f9cfcbf3f965a7b1d2dcac8d95ccb13d434e08e5fa`. Both upstream packages assert this value in their own tests. It is the only upstream known answer for the instance functions.
- `tree*_path_walk_*`: the root from the sparse level-by-level builder equals the root from walking the authentication path, the way a circuit does.
- `circom_matches_json_vectors`: the circuit outputs equal the published JSON entries for H1(1), H2(1,2), H3(1,2,3), H1(r-1) and H2(r-1,r-1).
- `negative_control_swapped_inputs_differ`: H2(1,2) differs from H2(2,1) and H3(1,2,3) differs from H3(3,2,1), so the comparison is not vacuous.

## Constraint counts

Default optimization (`--O1`, the command from the brief):

| Circuit | Non-linear | Linear | Wires |
| --- | --- | --- | --- |
| `kat.circom` (H1 + H2 + H3) | 720 | 1152 | 1876 |
| Poseidon255(1), t = 2 | 216 | 256 | 474 |
| Poseidon255(2), t = 3 | 240 | 384 | 627 |
| Poseidon255(3), t = 4 | 264 | 512 | 780 |

The three single-template counts sum exactly to the `kat` counts.
Non-linear = 3 x (8t + 56). Each x^5 S-box costs 3 multiplications. The 8 full rounds use t S-boxes each and the 56 partial rounds use one.
Linear = 128t in all three cases. That matches one constraint per round-constant addition plus one per MDS output, 64 rounds x t lanes each. This breakdown is read from the template, not traced in the r1cs.

Supplementary, `--O2` (full linear simplification):

| Circuit | Non-linear | Linear | Wires |
| --- | --- | --- | --- |
| `kat.circom` | 711 | 0 | 715 |
| Poseidon255(1) | 213 | 0 | 215 |
| Poseidon255(2) | 237 | 0 | 240 |
| Poseidon255(3) | 261 | 0 | 265 |

Each template loses 3 non-linear constraints under `--O2`. A likely cause is that the capacity lane in round 0 is the constant C[0], so its S-box folds to a constant. This explanation was not verified.

## JavaScript functions called

From `poseidon-bls12381` (CommonJS; loaded with `import poseidon from "poseidon-bls12381"`; named ESM imports also work):

- H1(a) = `poseidon1([a])`
- H2(a, b) = `poseidon2([a, b])`
- H3(a, b, c) = `poseidon3([a, b, c])`

Each takes an array of exact length and returns a BigInt.
Both libraries use state `[0, in...]` (capacity lane first, initialised to 0), R_F = 8, R_P = 56 for n = 1..3, x^5, and output state[0].
The field prime in both libraries equals r from the brief.

## Key values (decimal)

| Item | Value |
| --- | --- |
| H1(1) | 33312903538086167554741214005086116725441315171650202128840830167854170336490 |
| H2(1,2) | 28821147804331559602169231704816259064962739503761913593647409715501647586810 |
| H3(1,2,3) | 41091099622722973056082071867846799679887891223501702244297781245659866568853 |
| Z[32] (empty root) | 34147729537948564452788589313828361831422685361580832702235439851958634889397 |
| note precommitment | 7804547571376060123316069248076895932850031953822444106594559586999678602896 |
| note commitment | 25774960505238821075274772195585739030769339872205046610252935787521405310031 |
| note nullifierHash | 39931036134437929071662103397633869899593947182626814510062446930794907636202 |
| tree_example_1 root | 41575667297252774047664012125459209856646049272089381757727633024565983987862 |
| second note commitment | 29348268626606385949476924076909126625122473558957859785832003957964309116132 |
| tree_example_2 root | 1340925349014447301927427273926538909429425436400238753938505309885490857044 |

The note is nullifier = 11, secret = 22, value = 5000000, label = 33.
The second note is nullifier = 12, secret = 23, value = 7000000, label = 34.
The 32 siblings for index 1 are the first commitment, then Z[1]..Z[31].
All other values are in `out/poseidon-vectors.json`.

## Pitfalls found

1. The JavaScript library does not range-check inputs. H1(r) equals H1(0), and H2(r, 1) equals H2(0, 1). The circuit only sees field elements, so off-chain code must reject values >= r. Otherwise one note can have two encodings.
2. Input types: the functions accept BigInt or numeric strings (decimal or `0x` hex). A JS Number throws "Expected a BigInt or String".
3. A script that calls `snarkjs.wtns.calculate` and `snarkjs.wtns.check` does not exit by itself. A test without `process.exit` was killed by a 60 s timeout (exit 124). The likely cause is the curve worker threads that snarkjs starts. `parity.mjs` calls `process.exit`.
4. `snarkjs.wtns.check` calls `logger.warn` when a witness is wrong. Passing no logger would crash on exactly the failure path, so `parity.mjs` passes a logger object. This comes from reading the snarkjs source.
5. circom2 runs circom under WASI with path access tied to the working directory. In a test copy with a symlinked `node_modules`, it failed with `error[P1006]: Could not open file "node_modules/poseidon-bls12381-circom/..."`. Run it from this directory with a real `node_modules`.
6. The upstream JS test named "Test vector for BLS12-381 and t = 3 from paper repository" uses R_P = 57 and different round constants. It is not a known answer for `poseidon2`. Other Poseidon BLS12-381 implementations may also differ, so these vectors only fit this exact parameter set.
7. Constraint counts depend on the optimization flag (216 at `--O1` vs 213 at `--O2` for Poseidon255(1)). A spec should name the flag.
8. The witness index of each output is read from `out/kat.sym` (`main.h1`, `main.h2`, `main.h3` are entries 1, 2, 3), not assumed.
9. Leaf indices in the tree code use `Math.floor(i / 2)`, not `>>`. JS `>>` is a signed 32-bit operator and breaks for indices >= 2^31 in a depth-32 tree. This is a precaution; no test hit it.
10. `npm install` reported 3 high severity advisories in the dependency tree. They were not investigated, because this is a throwaway spike.

No mismatch between the circom template and the JavaScript library was found.
