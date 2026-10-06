#!/usr/bin/env bash
# Rerun every check of the spike and print one line per check:
# "PASS <name>" or "FAIL <name>". Exits non-zero if any check fails.
# Command output goes to out/verify.log.
#
# The trusted setup and the two proofs are reused when they exist (see
# scripts/prove.sh for why); pass --force to rebuild everything from scratch.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
mkdir -p out
LOG="$ROOT/out/verify.log"
: > "$LOG"

AIKEN="$ROOT/tools/aiken-1.1.24/aiken-aarch64-apple-darwin/aiken"
SNARKJS=(npx --no-install snarkjs)
# Keep Aiken's package cache inside the work directory.
AIKEN_HOME="$ROOT/tools/aiken-home"

FAILED=0
report() { # $1 = name, $2 = exit status of the check
  if [[ "$2" == 0 ]]; then echo "PASS $1"; else echo "FAIL $1"; FAILED=1; fi
}
run() { # $1 = name, rest = command; output goes to the log
  local name="$1"; shift
  echo "### $name: $*" >> "$LOG"
  "$@" >> "$LOG" 2>&1
  report "$name" $?
}

# --- Tool versions -----------------------------------------------------------
run tool_aiken_v1.1.24 bash -c '"$0" --version | grep -q "^aiken v1.1.24"' "$AIKEN"
run tool_circom2_0.2.23 bash -c 'npx --no-install circom2 --version | grep -q "circom2 npm package 0.2.23"'
run tool_snarkjs_0.7.6 bash -c 'npx --no-install snarkjs --version 2>&1 | grep -q "snarkjs@0.7.6"'
run tool_noble_curves_2.4.0 grep -q '"version": "2.4.0"' node_modules/@noble/curves/package.json

# --- Part 1: circuit, setup, proofs -----------------------------------------
run prove_sh bash scripts/prove.sh "$@"
for p in proof1 proof2; do
  run "snarkjs_verify_$p" "${SNARKJS[@]}" groth16 verify \
    build/verification_key.json "build/$p/public.json" "build/$p/proof.json"
done
run public_signals_proof1_17_5 bash -c '[[ "$(tr -d " \n" < build/proof1/public.json)" == "[\"17\",\"5\"]" ]]'
run public_signals_proof2_42_0 bash -c '[[ "$(tr -d " \n" < build/proof2/public.json)" == "[\"42\",\"0\"]" ]]'

# --- Part 2: compression to Zcash bytes, with self-checks --------------------
run compress_selfchecks node scripts/compress.mjs
run vectors_json_exists test -s out/vectors.json

# --- Part 3: Aiken Groth16 verifier -----------------------------------------
run gen_aiken_test node scripts/gen_aiken_test.mjs
run aiken_fmt_check bash -c 'cd aiken && HOME="$1" "$0" fmt --check' "$AIKEN" "$AIKEN_HOME"
# stdout is JSON because it is not a terminal; stderr carries compiler logs.
echo "### aiken_check" >> "$LOG"
(cd aiken && HOME="$AIKEN_HOME" "$AIKEN" check > "$ROOT/out/aiken-check.json" 2>> "$LOG")
report aiken_check_exit_0 $?
run aiken_check_json_exists test -s out/aiken-check.json

# Each required test must exist and pass. Every test asserts its expected
# polarity itself (for example `!verify(...)`), so "pass" means "behaves as
# stated".
for t in valid_proof_1 valid_proof_2 tampered_proof_fails wrong_public_input_fails \
  aliased_input_fails aliased_input_control_without_v1 msm_path_matches \
  valid_proof_1_msm valid_proof_2_msm infinity_proof_point_fails \
  wrong_length_proof_point_fails invalid_point_bytes_error \
  input_count_mismatch_fails msm_reduces_scalars_mod_r msm_ignores_extra_elements; do
  run "aiken_test_$t" node -e '
    const j = JSON.parse(require("fs").readFileSync("out/aiken-check.json", "utf8"));
    const t = j.modules.flatMap((m) => m.tests).find((t) => t.title === process.argv[1]);
    if (!t) { console.error("missing test", process.argv[1]); process.exit(1); }
    console.log(t.title, t.status, JSON.stringify(t.execution_units));
    process.exit(t.status === "pass" ? 0 : 1);' "$t"
done

# --- Part 4: MPF v2.1.0 + stdlib matrix -------------------------------------
run gen_mpf_test node scripts/gen_mpf_test.mjs
echo "### mpf_matrix" >> "$LOG"
MATRIX="$(bash scripts/mpf_matrix.sh 2>> "$LOG")"
echo "$MATRIX" >> "$LOG"
for ver in v2.2.1 v3.1.0 v4.0.0; do
  grep -qx "$ver exit=0 passed=2/2" <<< "$MATRIX"
  report "mpf_stdlib_${ver}_compiles_and_passes" $?
done

echo "--- details in out/verify.log"
exit "$FAILED"
