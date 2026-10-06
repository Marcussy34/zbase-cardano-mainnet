#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
force=0
if [[ "${1:-}" == "--force" && "$#" == 1 ]]; then
  force=1
elif [[ "$#" != 0 ]]; then
  echo "Usage: bash circuits/scripts/build.sh [--force]" >&2
  exit 1
fi

mkdir -p circuits/build
compiler_version=$(npx --no-install circom2 --version)
digest=$(CIRCOM_VERSION="$compiler_version" node --input-type=module <<'JS'
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const hash = createHash("sha256").update(process.env.CIRCOM_VERSION);
hash.update(await readFile("circuits/scripts/build.sh"));
hash.update(await readFile("node_modules/poseidon-bls12381-circom/package.json"));
async function visit(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else hash.update(path).update("\0").update(await readFile(path)).update("\0");
  }
}
await visit("circuits/src");
console.log(hash.digest("hex"));
JS
)

for circuit in spend insert ragequit; do
  stamp="circuits/build/$circuit.build.sha256"
  if [[ "$force" == 0 && -f "$stamp" && "$(cat "$stamp")" == "$digest" \
    && -f "circuits/build/$circuit.r1cs" && -f "circuits/build/$circuit.sym" \
    && -f "circuits/build/${circuit}_js/$circuit.wasm" ]]; then
    echo "$circuit: unchanged, using compiled files"
  else
    # Invalidate first so an interrupted compiler cannot leave a valid cache stamp.
    rm -f "$stamp"
    npx --no-install circom2 "circuits/src/main/$circuit.circom" \
      --prime bls12381 --O2 --r1cs --wasm --sym -l node_modules -o circuits/build
    printf '%s\n' "$digest" > "$stamp"
  fi
done

node circuits/scripts/public-signals.mjs --summary
