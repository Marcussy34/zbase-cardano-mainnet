#!/usr/bin/env bash
# Part 1 of the spike: compile the circuit over BLS12-381, run a development
# Groth16 setup with snarkjs, and produce two proofs.
#
# Usage: bash scripts/prove.sh [--force]
#   Without --force the trusted setup (ptau and zkey) is reused when present,
#   because snarkjs mixes OS randomness into every contribution (the -e
#   entropy is hashed together with crypto.randomBytes), so a rerun would
#   produce a new key and invalidate the recorded vectors.
#   Proofs are also randomized (Groth16 r, s), so they are only regenerated
#   when missing or when --force is given.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

SNARKJS=(npx --no-install snarkjs)
BUILD="$ROOT/build"
mkdir -p "$BUILD"

if [[ "$FORCE" == 1 ]]; then
  rm -rf "$BUILD"
  mkdir -p "$BUILD"
fi

# 1. Compile. --prime bls12381 makes the witness generator work modulo the
#    BLS12-381 scalar field r instead of the default bn128 field.
if [[ ! -f "$BUILD/mul.r1cs" ]]; then
  npx --no-install circom2 circuit/mul.circom --r1cs --wasm --sym --prime bls12381 -o "$BUILD"
fi
"${SNARKJS[@]}" r1cs info "$BUILD/mul.r1cs"

# 2. Development powers of tau on bls12-381 (2^8 constraints is plenty).
#    Fixed entropy strings keep the commands non-interactive.
if [[ ! -f "$BUILD/pot8_final.ptau" ]]; then
  "${SNARKJS[@]}" powersoftau new bls12-381 8 "$BUILD/pot8_0000.ptau"
  "${SNARKJS[@]}" powersoftau contribute "$BUILD/pot8_0000.ptau" "$BUILD/pot8_0001.ptau" \
    --name="spike ptau contribution" -e="spike-ptau-entropy-not-secret"
  "${SNARKJS[@]}" powersoftau prepare phase2 "$BUILD/pot8_0001.ptau" "$BUILD/pot8_final.ptau"
fi

# 3. Circuit specific Groth16 setup plus one phase 2 contribution.
if [[ ! -f "$BUILD/mul_final.zkey" ]]; then
  "${SNARKJS[@]}" groth16 setup "$BUILD/mul.r1cs" "$BUILD/pot8_final.ptau" "$BUILD/mul_0000.zkey"
  "${SNARKJS[@]}" zkey contribute "$BUILD/mul_0000.zkey" "$BUILD/mul_final.zkey" \
    --name="spike zkey contribution" -e="spike-zkey-entropy-not-secret"
  # A new key invalidates any older proofs.
  rm -rf "$BUILD/proof1" "$BUILD/proof2"
fi

# 4. Export the verification key (deterministic given the zkey).
"${SNARKJS[@]}" zkey export verificationkey "$BUILD/mul_final.zkey" "$BUILD/verification_key.json"

# 5. Witness and proof for one input set. $1 = name, $2 = input JSON.
prove_one() {
  local name="$1" input="$2" dir="$BUILD/$1"
  mkdir -p "$dir"
  if [[ ! -f "$dir/proof.json" ]]; then
    printf '%s\n' "$input" > "$dir/input.json"
    "${SNARKJS[@]}" wtns calculate "$BUILD/mul_js/mul.wasm" "$dir/input.json" "$dir/witness.wtns"
    "${SNARKJS[@]}" groth16 prove "$BUILD/mul_final.zkey" "$dir/witness.wtns" "$dir/proof.json" "$dir/public.json"
  fi
  # snarkjs prints "OK!" on success and exits non-zero on failure.
  "${SNARKJS[@]}" groth16 verify "$BUILD/verification_key.json" "$dir/public.json" "$dir/proof.json"
}

# Proof 1: a=3, b=4, c=5, so d=17 and public signals are [17, 5].
prove_one proof1 '{"a": "3", "b": "4", "c": "5"}'
# Proof 2: a=6, b=7, c=0, so d=42 and public signals are [42, 0].
prove_one proof2 '{"a": "6", "b": "7", "c": "0"}'

echo "public signals proof1: $(tr -d ' \n' < "$BUILD/proof1/public.json")"
echo "public signals proof2: $(tr -d ' \n' < "$BUILD/proof2/public.json")"
