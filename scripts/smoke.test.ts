import assert from "node:assert/strict";
import test from "node:test";

test("CRY-01 smoke: Poseidon H2 matches the known answer", async () => {
  const { poseidon2 } = await import("poseidon-bls12381");
  assert.equal(
    poseidon2([1n, 2n]),
    28821147804331559602169231704816259064962739503761913593647409715501647586810n,
  );
});

test("CRY-08 smoke: the BLS12-381 G1 generator compresses to 48 bytes", async () => {
  const { bls12_381 } = await import("@noble/curves/bls12-381.js");
  assert.equal(bls12_381.G1.Point.BASE.toBytes(true).length, 48);
});

test("WP0 smoke: snarkjs exposes groth16.fullProve", async () => {
  // Types come from @types/snarkjs. The runtime check below is the point.
  const { groth16 } = await import("snarkjs");
  assert.equal(typeof groth16.fullProve, "function");
});

test("WP0 smoke: Mesh exposes MeshTxBuilder", async () => {
  const { MeshTxBuilder } = await import("@meshsdk/core");
  assert.equal(typeof MeshTxBuilder, "function");
});

test("WP0 smoke: x402 Cardano exposes ExactCardanoScheme", async () => {
  const { ExactCardanoScheme } = await import("@x402/cardano");
  assert.equal(typeof ExactCardanoScheme, "function");
});

test("WP0 smoke: an empty MPF trie stores the Aiken empty root", async () => {
  const { Trie } = await import("@aiken-lang/merkle-patricia-forestry");
  const trie = await Trie.fromList([]);
  assert.equal(trie.isEmpty(), true);
  assert.equal(trie.hash, null);

  // The JavaScript library serializes its null sentinel as 32 zero bytes.
  const root = await trie.store.get(
    "__root__",
    (_key: unknown, value: unknown) => value,
  );
  assert.equal(
    root,
    "0000000000000000000000000000000000000000000000000000000000000000",
  );
});
