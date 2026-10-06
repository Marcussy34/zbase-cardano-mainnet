// Parity between the circom template Poseidon255(n) (poseidon-bls12381-circom@1.0.0)
// and the JavaScript library (poseidon-bls12381@1.0.2). Expects verify.sh to have
// compiled kat.circom and kat_h{1,2,3}.circom into out/ with the logs in out/compile_*.log.
// Prints one "PASS <name>" or "FAIL <name>" line per check.
import { readFileSync, writeFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import poseidon from "poseidon-bls12381";

const { poseidon1, poseidon2, poseidon3 } = poseidon;

const R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
const WASM = "out/kat_js/kat.wasm";
const R1CS = "out/kat.r1cs";

let failed = false;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `  ${detail}` : ""}`);
  if (!ok) failed = true;
}

// snarkjs.wtns.check calls logger.warn on failure, so it needs a real logger object.
const logger = { debug() {}, info() {}, warn: (m) => console.error(m), error: (m) => console.error(m) };

// Witness index of each named signal, from the .sym file (label,witnessIdx,component,name).
const sym = new Map(
  readFileSync("out/kat.sym", "utf8").trim().split("\n").map((l) => {
    const [, w, , name] = l.split(",");
    return [name, Number(w)];
  }),
);
const outIdx = ["h1", "h2", "h3"].map((s) => sym.get(`main.${s}`));

const cases = [
  { name: "1_2_3", a: 1n, b: 2n, c: 3n },
  { name: "rm1_rm1_5", a: R - 1n, b: R - 1n, c: 5n },
];

const results = [];
for (const { name, a, b, c } of cases) {
  // Inputs go to snarkjs as decimal strings; it converts them to BigInt internally.
  const input = { a: a.toString(), b: b.toString(), c: c.toString() };
  writeFileSync(`out/input_${name}.json`, JSON.stringify(input, null, 2) + "\n");
  const wtnsFile = `out/kat_${name}.wtns`;
  await snarkjs.wtns.calculate(input, WASM, wtnsFile);
  check(`witness_satisfies_r1cs_${name}`, await snarkjs.wtns.check(R1CS, wtnsFile, logger));

  const witness = await snarkjs.wtns.exportJson(wtnsFile);
  const circuit = outIdx.map((i) => BigInt(witness[i]));
  const js = [poseidon1([a]), poseidon2([a, b]), poseidon3([a, b, c])];
  ["h1", "h2", "h3"].forEach((h, k) => {
    check(`parity_${name}_${h}`, circuit[k] === js[k], `circom=${circuit[k]} js=${js[k]}`);
  });
  results.push({
    inputs: input,
    circom: Object.fromEntries(circuit.map((v, k) => [`h${k + 1}`, v.toString()])),
    js: Object.fromEntries(js.map((v, k) => [`h${k + 1}`, v.toString()])),
  });
}
writeFileSync("out/parity-results.json", JSON.stringify(results, null, 2) + "\n");

// Tie the circuit to the published vectors: overlapping entries must match the JSON file.
const vec = JSON.parse(readFileSync("out/poseidon-vectors.json", "utf8"));
const find = (arr, ins) => arr.find((e) => e.inputs.join(",") === ins.join(","))?.output;
const rm1 = (R - 1n).toString();
const [p1, p2] = results.map((r) => r.circom);
check(
  "circom_matches_json_vectors",
  p1.h1 === find(vec.h1, ["1"]) && p1.h2 === find(vec.h2, ["1", "2"]) &&
  p1.h3 === find(vec.h3, ["1", "2", "3"]) && p2.h1 === find(vec.h1, [rm1]) &&
  p2.h2 === find(vec.h2, [rm1, rm1]),
);

// Negative control: the comparison must notice when input order changes the hash,
// so a vacuous "everything equal" result cannot pass.
check(
  "negative_control_swapped_inputs_differ",
  p1.h2 !== poseidon2([2n, 1n]).toString() && p1.h3 !== poseidon3([3n, 2n, 1n]).toString(),
);

// ---- Constraint counts, parsed from the circom compiler output ----
function counts(circuit) {
  const log = readFileSync(`out/compile_${circuit}.log`, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  const num = (label) => Number(log.match(new RegExp(`^${label}: (\\d+)$`, "m"))?.[1]);
  return { nonLinear: num("non-linear constraints"), linear: num("linear constraints"), wires: num("wires") };
}
const kat = counts("kat");
const single = [1, 2, 3].map((n) => counts(`kat_h${n}`));
writeFileSync(
  "out/constraints.json",
  JSON.stringify({ kat, poseidon255_1: single[0], poseidon255_2: single[1], poseidon255_3: single[2] }, null, 2) + "\n",
);
console.error(
  `constraints: kat ${kat.nonLinear}/${kat.linear}, ` +
  single.map((s, i) => `Poseidon255(${i + 1}) ${s.nonLinear}/${s.linear}`).join(", ") +
  " (non-linear/linear)",
);

// Expected non-linear count: each x^5 S-box is 3 multiplications; 8 full rounds apply
// t = n + 1 S-boxes, 56 partial rounds apply 1 (N_P = 56 for n = 1..3 in the template).
check(
  "constraints_nonlinear_match_sbox_formula",
  single.every((s, i) => s.nonLinear === 3 * (8 * (i + 2) + 56)),
);
check(
  "constraints_kat_equals_sum_of_single_templates",
  kat.nonLinear === single.reduce((x, s) => x + s.nonLinear, 0) &&
  kat.linear === single.reduce((x, s) => x + s.linear, 0),
);

// snarkjs keeps curve worker threads alive, so exit explicitly.
process.exit(failed ? 1 : 0);
