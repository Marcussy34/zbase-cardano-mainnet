#!/usr/bin/env bash
# Reruns the Poseidon255 known-answer spike from scratch and prints one line per check:
# "PASS <name>" or "FAIL <name>". Exits non-zero if any check fails.
# Usage: bash verify.sh   (expects node_modules from: npm install, with the pinned versions)
set -u
cd "$(dirname "$0")" || exit 1

fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }

# Runs a node script that prints its own PASS/FAIL lines. A crash without any
# FAIL line (for example an exception) is reported as its own FAIL.
run_checks() {
  local name="$1"; shift
  local out status
  out="$(node "$@" 2>"out/$name.stderr.log")"
  status=$?
  [ -n "$out" ] && echo "$out"
  fails=$((fails + $(printf '%s\n' "$out" | grep -c '^FAIL ')))
  if [ "$status" -ne 0 ] && ! printf '%s\n' "$out" | grep -q '^FAIL '; then
    fail "${name}_script_crashed_see_out/$name.stderr.log"
  fi
}

# 1. Installed packages must be the exact pinned versions.
versions="$(node -e '
  const want = { "poseidon-bls12381": "1.0.2", "poseidon-bls12381-circom": "1.0.0",
    circom2: "0.2.23", snarkjs: "0.7.6", circomlib: "2.0.5" };
  for (const [p, v] of Object.entries(want)) {
    let got = "missing";
    try { got = require(`./node_modules/${p}/package.json`).version; } catch {}
    if (got !== v) console.log(`${p}=${got}`);
  }' 2>&1)"
if [ -z "$versions" ]; then pass pinned_package_versions; else fail "pinned_package_versions ($versions)"; fi

# 2. Start from an empty output directory.
rm -rf out
mkdir -p out

# 3. Deliverable A: JavaScript vectors and their self-checks.
run_checks vectors vectors.mjs

# 4. Deliverable B: compile the parity circuit and the three single-template circuits.
for c in kat kat_h1 kat_h2 kat_h3; do
  if npx circom2 "$c.circom" --r1cs --wasm --sym --prime bls12381 -l node_modules -o out \
      >"out/compile_$c.log" 2>&1 && grep -q "Everything went okay" "out/compile_$c.log"; then
    pass "compile_$c"
  else
    fail "compile_$c"
  fi
done

# 5. Deliverable B: witnesses with snarkjs, circom vs JavaScript parity, constraint counts.
run_checks parity parity.mjs

if [ "$fails" -ne 0 ]; then exit 1; fi
exit 0
