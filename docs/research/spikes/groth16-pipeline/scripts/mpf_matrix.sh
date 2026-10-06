#!/usr/bin/env bash
# Part 4 of the spike: build aiken-mpf against each stdlib version with
# Aiken v1.1.24 and record the outcome.
#
# For each version the project (plus aiken/lib/spike/groth16.ak) is copied
# to build/mpf-matrix/stdlib-<ver>, the stdlib version in aiken.toml is
# replaced, and `aiken check` runs with a clean build directory. Results land in out/mpf-stdlib-<ver>.json
# (stdout, JSON test report) and out/mpf-stdlib-<ver>.stderr.txt
# (compiler messages, including any error text).
#
# Prints one line per version: "<ver> exit=<code> passed=<n>/<total>".
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AIKEN="$ROOT/tools/aiken-1.1.24/aiken-aarch64-apple-darwin/aiken"
# Keep Aiken's package cache inside the work directory, not in ~/Library.
export HOME="$ROOT/tools/aiken-home"
# Plain output: no ANSI colours in the captured error text.
export NO_COLOR=1

for ver in v2.2.1 v3.1.0 v4.0.0; do
  dir="$ROOT/build/mpf-matrix/stdlib-$ver"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp -R "$ROOT/aiken-mpf/lib" "$dir/lib"
  # Also type-check the spike Groth16 verifier in the same project, so the
  # result covers the MPF + verifier combination (its tests stay in aiken/).
  cp "$ROOT/aiken/lib/spike/groth16.ak" "$dir/lib/spike/groth16.ak"
  # Swap only the stdlib version line (the one after its name line).
  sed '/name = "aiken-lang\/stdlib"/{n;s/^version = .*/version = "'"$ver"'"/;}' \
    "$ROOT/aiken-mpf/aiken.toml" > "$dir/aiken.toml"
  (cd "$dir" && "$AIKEN" check > "$ROOT/out/mpf-stdlib-$ver.json" 2> "$ROOT/out/mpf-stdlib-$ver.stderr.txt")
  code=$?
  summary="$(node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(`${j.summary.passed}/${j.summary.total}`);
    } catch { console.log("0/0"); }' "$ROOT/out/mpf-stdlib-$ver.json")"
  echo "$ver exit=$code passed=$summary"
done
