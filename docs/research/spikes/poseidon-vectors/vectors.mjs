// Known-answer vectors for Poseidon255 (BLS12-381 scalar field), computed with
// the JavaScript library poseidon-bls12381@1.0.2. Writes out/poseidon-vectors.json
// and prints one "PASS <name>" or "FAIL <name>" line per self-check.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
// The package is CommonJS; load it through its default export from this ES module.
import poseidon from "poseidon-bls12381";

const { poseidon1, poseidon2, poseidon3 } = poseidon;

const R =
  0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
const DEPTH = 32;
const OUT_FILE = "out/poseidon-vectors.json";

// Each library function takes an array of BigInt (or numeric strings) of exact length.
const H1 = (a) => poseidon1([a]);
const H2 = (a, b) => poseidon2([a, b]);
const H3 = (a, b, c) => poseidon3([a, b, c]);

let failed = false;
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed = true;
}

const dec = (x) => x.toString(10);

// Zero hashes: Z[0] = 0 (empty leaf), Z[i+1] = H2(Z[i], Z[i]).
const Z = [0n];
for (let i = 0; i < DEPTH; i++) Z.push(H2(Z[i], Z[i]));

function note(nullifier, secret, value, label) {
  const precommitment = H2(nullifier, secret);
  const commitment = H3(value, label, precommitment);
  const nullifierHash = H1(nullifier);
  return { nullifier, secret, value, label, precommitment, commitment, nullifierHash };
}

const noteJson = (n) => Object.fromEntries(Object.entries(n).map(([k, v]) => [k, dec(v)]));

// Sparse tree builder: keeps only non-empty nodes per level and uses Z[i] for
// any missing node at level i. Indices stay as Numbers (< 2^32), so use
// Math.floor instead of ">>", which is a signed 32-bit operator in JS.
function buildTree(leaves) {
  const levels = [new Map(leaves)];
  for (let i = 0; i < DEPTH; i++) {
    const cur = levels[i];
    const next = new Map();
    for (const idx of cur.keys()) {
      const parent = Math.floor(idx / 2);
      if (next.has(parent)) continue;
      const left = cur.get(parent * 2) ?? Z[i];
      const right = cur.get(parent * 2 + 1) ?? Z[i];
      next.set(parent, H2(left, right));
    }
    levels.push(next);
  }
  return { root: levels[DEPTH].get(0) ?? Z[DEPTH], levels };
}

function siblings(levels, index) {
  const sibs = [];
  for (let i = 0; i < DEPTH; i++) {
    const sib = Math.floor(index / 2 ** i) ^ 1;
    sibs.push(levels[i].get(sib) ?? Z[i]);
  }
  return sibs;
}

// Independent recomputation along the authentication path, the way a circuit does it.
// Path bit i (LSB first) = 1 means the current node is the right child at level i.
function rootFromPath(leaf, index, sibs) {
  let node = leaf;
  for (let i = 0; i < DEPTH; i++) {
    const bit = Math.floor(index / 2 ** i) % 2;
    node = bit ? H2(sibs[i], node) : H2(node, sibs[i]);
  }
  return node;
}

const pathBits = (index) =>
  Array.from({ length: DEPTH }, (_, i) => Math.floor(index / 2 ** i) % 2);

// ---- Vectors ----
const h1Inputs = [[0n], [1n], [2n], [R - 1n]];
const h2Inputs = [[0n, 0n], [1n, 2n], [2n, 1n], [R - 1n, R - 1n]];
const h3Inputs = [[0n, 0n, 0n], [1n, 2n, 3n], [3n, 2n, 1n]];
const entry = (fn) => (ins) => ({ inputs: ins.map(dec), output: dec(fn(...ins)) });

const n1 = note(11n, 22n, 5000000n, 33n);
const n2 = note(12n, 23n, 7000000n, 34n);

const t1 = buildTree([[0, n1.commitment]]);
const t2 = buildTree([[0, n1.commitment], [1, n2.commitment]]);
const t1Sibs0 = siblings(t1.levels, 0);
const t2Sibs0 = siblings(t2.levels, 0);
const t2Sibs1 = siblings(t2.levels, 1);

const vectors = {
  meta: {
    description: "Poseidon255 known-answer vectors over the BLS12-381 scalar field",
    field_prime_hex: "0x" + R.toString(16),
    field_prime: dec(R),
    library: "poseidon-bls12381@1.0.2",
    functions: { h1: "poseidon1([a])", h2: "poseidon2([a, b])", h3: "poseidon3([a, b, c])" },
    encoding: "all field elements are decimal strings",
    tree: "depth 32, node = H2(left, right), empty leaf = 0, path bit i (LSB first) = 1 when the node is the right child at level i",
  },
  h1: h1Inputs.map(entry(H1)),
  h2: h2Inputs.map(entry(H2)),
  h3: h3Inputs.map(entry(H3)),
  zero_hashes: Z.map(dec),
  empty_root: dec(Z[DEPTH]),
  note_example: noteJson(n1),
  tree_example_1: {
    depth: DEPTH,
    leaves: [{ index: 0, leaf: dec(n1.commitment) }],
    root: dec(t1.root),
  },
  tree_example_2: {
    depth: DEPTH,
    second_note: noteJson(n2),
    leaves: [
      { index: 0, leaf: dec(n1.commitment) },
      { index: 1, leaf: dec(n2.commitment) },
    ],
    root: dec(t2.root),
    index_1_path_bits: pathBits(1),
    index_1_siblings: t2Sibs1.map(dec),
  },
};

mkdirSync("out", { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(vectors, null, 2) + "\n");

// ---- Self-checks ----

// Anchor: both upstream packages assert poseidon2([1, 2]) equals this value in their own tests.
check(
  "js_upstream_kat_h2_1_2",
  H2(1n, 2n) === 0x3fb8310b0e962b75bffec5f9cfcbf3f965a7b1d2dcac8d95ccb13d434e08e5fan,
);

// Encoding: decimal strings, hex strings and BigInt give the same hash; JS Numbers are rejected.
let numberRejected = false;
try {
  poseidon2([1, 2]);
} catch {
  numberRejected = true;
}
check(
  "js_input_encoding_bigint_string_hex_agree_number_rejected",
  poseidon2(["1", "2"]) === H2(1n, 2n) && poseidon2(["0x01", "0x02"]) === H2(1n, 2n) && numberRejected,
);

// The library does not range-check inputs: r behaves exactly like 0. Callers must enforce x < r.
check("js_no_range_check_input_r_aliases_0", H1(R) === H1(0n) && H2(R, 1n) === H2(0n, 1n));

check("tree1_root_matches_path_walk_index_0", rootFromPath(n1.commitment, 0, t1Sibs0) === t1.root);
check(
  "tree1_siblings_index_0_are_zero_hashes",
  t1Sibs0.every((s, i) => s === Z[i]),
);
check("tree2_root_matches_path_walk_index_1", rootFromPath(n2.commitment, 1, t2Sibs1) === t2.root);
check("tree2_root_matches_path_walk_index_0", rootFromPath(n1.commitment, 0, t2Sibs0) === t2.root);
check(
  "tree2_siblings_index_1_are_leaf0_then_zero_hashes",
  t2Sibs1[0] === n1.commitment && t2Sibs1.slice(1).every((s, i) => s === Z[i + 1]),
);

// Re-read the file from disk and confirm every required item is present and canonical.
const disk = JSON.parse(readFileSync(OUT_FILE, "utf8"));
const isField = (s) => typeof s === "string" && /^[0-9]+$/.test(s) && BigInt(s) < R;
const allField = (arr) => Array.isArray(arr) && arr.every(isField);
const entriesOk = (arr, n, arity) =>
  Array.isArray(arr) && arr.length === n &&
  arr.every((e) => e.inputs.length === arity && allField(e.inputs) && isField(e.output));
const noteOk = (n) =>
  ["nullifier", "secret", "value", "label", "precommitment", "commitment", "nullifierHash"].every((k) => isField(n?.[k]));
check(
  "json_complete",
  entriesOk(disk.h1, 4, 1) && entriesOk(disk.h2, 4, 2) && entriesOk(disk.h3, 3, 3) &&
  disk.zero_hashes.length === 33 && allField(disk.zero_hashes) && disk.zero_hashes[0] === "0" &&
  disk.empty_root === disk.zero_hashes[32] &&
  noteOk(disk.note_example) && noteOk(disk.tree_example_2.second_note) &&
  isField(disk.tree_example_1.root) && isField(disk.tree_example_2.root) &&
  disk.tree_example_2.index_1_siblings.length === 32 && allField(disk.tree_example_2.index_1_siblings),
);

process.exit(failed ? 1 : 0);
