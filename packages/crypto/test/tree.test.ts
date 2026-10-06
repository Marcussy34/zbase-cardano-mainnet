import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { R } from "../src/field.js";
import { h2 } from "../src/poseidon.js";
import {
  MerkleTree,
  TREE_DEPTH,
  ZERO_HASHES,
  rootFromPath,
} from "../src/tree.js";

interface TreeVector {
  depth?: number;
  leaves: { index: number; leaf: string }[];
  root: string;
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../docs/vectors/poseidon-vectors.json", import.meta.url),
    "utf8",
  ),
) as {
  zero_hashes: string[];
  empty_root: string;
  tree_example_1: TreeVector;
  tree_example_2: TreeVector & {
    index_1_path_bits: number[];
    index_1_siblings: string[];
  };
};

const zeros = vectors.zero_hashes.map(BigInt);
const firstLeaves = vectors.tree_example_1.leaves.map(({ leaf }) => BigInt(leaf));
const twoLeaves = vectors.tree_example_2.leaves.map(({ leaf }) => BigInt(leaf));
const fiveLeaves = [...twoLeaves, 3n, 4n, 5n];
const capacity = 2 ** 32;

test("CRY-02 zero hashes match all 33 vectors and are frozen", () => {
  assert.equal(TREE_DEPTH, 32);
  assert.deepEqual(ZERO_HASHES, zeros);
  assert.equal(Object.isFrozen(ZERO_HASHES), true);
});

test("CRY-02 an empty tree has the known empty root", () => {
  const tree = MerkleTree.empty();
  assert.equal(tree.size, 0);
  assert.equal(tree.root, BigInt(vectors.empty_root));
  assert.equal(tree.root, ZERO_HASHES[32]);
});

test("CRY-04 the one-leaf root and path match the vectors", () => {
  const tree = MerkleTree.fromLeaves(firstLeaves);
  assert.equal(tree.size, 1);
  assert.equal(tree.root, BigInt(vectors.tree_example_1.root));
  assert.deepEqual(tree.path(0), {
    siblings: zeros.slice(0, 32),
    indexBits: Array<number>(32).fill(0),
  });
});

test("CRY-04 the two-leaf root and index 1 path match the vectors", () => {
  const tree = MerkleTree.fromLeaves(twoLeaves);
  assert.equal(tree.size, 2);
  assert.equal(tree.root, BigInt(vectors.tree_example_2.root));
  assert.deepEqual(tree.path(1), {
    siblings: vectors.tree_example_2.index_1_siblings.map(BigInt),
    indexBits: vectors.tree_example_2.index_1_path_bits,
  });
});

test("CRY-04 every leaf in a five-leaf tree reconstructs its root", () => {
  const tree = MerkleTree.fromLeaves(fiveLeaves);
  for (const [index, leaf] of fiveLeaves.entries()) {
    const path = tree.path(index);
    assert.equal(tree.leaf(index), leaf);
    assert.equal(rootFromPath(leaf, index, path.siblings), tree.root);
    assert.deepEqual(
      path.indexBits,
      Array.from({ length: 32 }, (_, level) => Math.floor(index / 2 ** level) % 2),
    );
  }
});

for (const size of [0, 1, 2, 5]) {
  test(`CRY-04 the next slot in a ${size}-leaf tree proves an empty leaf`, () => {
    const tree = MerkleTree.fromLeaves(fiveLeaves.slice(0, size));
    const siblings = tree.path(tree.size).siblings;
    assert.equal(siblings.length, 32);
    assert.equal(tree.leaf(tree.size), 0n);
    assert.equal(rootFromPath(0n, tree.size, siblings), tree.root);
    tree.append(6n);
    assert.equal(rootFromPath(6n, size, siblings), tree.root);
  });
}

test("CRY-04 paths handle empty slots above the signed 32-bit boundary", () => {
  const tree = MerkleTree.fromLeaves(fiveLeaves);
  for (const index of [2 ** 31, capacity - 1]) {
    const path = tree.path(index);
    assert.equal(tree.leaf(index), 0n);
    assert.equal(path.indexBits[31], 1);
    assert.equal(rootFromPath(0n, index, path.siblings), tree.root);
  }
  assert.deepEqual(tree.path(capacity - 1).indexBits, Array<number>(32).fill(1));
});

test("CRY-04 fromLeaves and sequential appends agree after cached root reads", () => {
  const tree = MerkleTree.empty();
  for (const [index, leaf] of fiveLeaves.entries()) {
    assert.equal(tree.append(leaf), index);
    assert.equal(tree.root, MerkleTree.fromLeaves(fiveLeaves.slice(0, index + 1)).root);
  }
  assert.equal(tree.size, fiveLeaves.length);
  assert.equal(tree.root, MerkleTree.fromLeaves(fiveLeaves).root);
});

test("CRY-04 cloning preserves dirty nodes and isolates later mutations", () => {
  const original = MerkleTree.fromLeaves(twoLeaves);
  const clone = original.clone();
  assert.equal(clone.root, BigInt(vectors.tree_example_2.root));
  assert.equal(clone.root, original.root);
  clone.append(3n);
  clone.set(0, 0n);
  assert.equal(original.size, 2);
  assert.equal(original.root, BigInt(vectors.tree_example_2.root));
  assert.equal(original.leaf(0), twoLeaves[0]);
  const cloneRoot = clone.root;
  original.set(1, 0n);
  assert.equal(clone.leaf(1), twoLeaves[1]);
  assert.equal(clone.root, cloneRoot);
});

test("CRY-04 cloning a cached tree preserves an independent cache", () => {
  const original = MerkleTree.fromLeaves(fiveLeaves);
  const originalRoot = original.root;
  const clone = original.clone();
  clone.set(4, 0n);
  assert.notEqual(clone.root, originalRoot);
  assert.equal(original.root, originalRoot);
  assert.equal(rootFromPath(5n, 4, original.path(4).siblings), originalRoot);
});

test("CRY-04 clearing the only leaf restores the empty root without shrinking size", () => {
  const tree = MerkleTree.fromLeaves(firstLeaves);
  assert.equal(tree.root, BigInt(vectors.tree_example_1.root));
  tree.set(0, 0n);
  assert.equal(tree.size, 1);
  assert.equal(tree.leaf(0), 0n);
  assert.equal(tree.root, BigInt(vectors.empty_root));
  assert.equal(tree.append(1n), 1);
});

test("CRY-04 set refreshes every affected path and preserves the other leaves", () => {
  const tree = MerkleTree.fromLeaves(fiveLeaves);
  const oldRoot = tree.root;
  tree.set(2, 0n);
  tree.set(4, 9n);
  const updated = [...twoLeaves, 0n, 4n, 9n];
  assert.notEqual(tree.root, oldRoot);
  assert.equal(tree.root, MerkleTree.fromLeaves(updated).root);
  for (const [index, leaf] of updated.entries()) {
    assert.equal(tree.leaf(index), leaf);
    assert.equal(rootFromPath(leaf, index, tree.path(index).siblings), tree.root);
  }
});

test("CRY-04 returned paths and input arrays share no mutable state with the tree", () => {
  const leaves = [...twoLeaves];
  const tree = MerkleTree.fromLeaves(leaves);
  const path = tree.path(1);
  leaves[0] = 0n;
  path.siblings[0] = 0n;
  path.indexBits[0] = 0;
  assert.equal(tree.root, BigInt(vectors.tree_example_2.root));
  assert.deepEqual(tree.path(1), {
    siblings: vectors.tree_example_2.index_1_siblings.map(BigInt),
    indexBits: vectors.tree_example_2.index_1_path_bits,
  });
});

test("CRY-04 200 appends and a root read cost fewer than 300 hashes", () => {
  let calls = 0;
  const tree = MerkleTree.empty((left, right) => {
    calls += 1;
    return h2(left, right);
  });
  for (let index = 0; index < 200; index += 1) {
    tree.append(BigInt(index + 1));
  }
  const root = tree.root;
  assert.ok(calls > 0 && calls < 300, `${calls} hashes for 200 appends`);
  const afterRoot = calls;
  assert.equal(tree.root, root);
  assert.equal(calls, afterRoot);
  const path = tree.path(199);
  assert.deepEqual(tree.path(199), path);
  assert.equal(calls, afterRoot);
  tree.set(100, 0n);
  assert.notEqual(tree.root, root);
  assert.equal(calls - afterRoot, 32);
});

test("CRY-04 reading a path twice hashes nothing on the second read", () => {
  let calls = 0;
  const tree = MerkleTree.fromLeaves(fiveLeaves, (left, right) => {
    calls += 1;
    return h2(left, right);
  });
  const path = tree.path(0);
  assert.equal(path.siblings.length, 32);
  const afterPath = calls;
  assert.deepEqual(tree.path(0), path);
  assert.equal(calls, afterPath);
  assert.equal(rootFromPath(fiveLeaves[0]!, 0, path.siblings), tree.root);
});

test("CRY-04 a supplied hash also determines empty subtrees and cloned trees", () => {
  const hash = (left: bigint, right: bigint): bigint => (left + 3n * right + 1n) % R;
  const tree = MerkleTree.fromLeaves([2n, 3n], hash);
  assert.equal(tree.size, 2);
  const expected = MerkleTree.empty(hash);
  assert.equal(rootFromPath(0n, 0, expected.path(0).siblings, hash), expected.root);
  const clone = tree.clone();
  clone.append(4n);
  assert.equal(rootFromPath(4n, 2, clone.path(2).siblings, hash), clone.root);
  assert.equal(rootFromPath(0n, 2, tree.path(2).siblings, hash), tree.root);
});

for (const invalid of [-1n, R, R + 1n]) {
  test(`CRY-10 append rejects non-canonical leaf ${invalid}`, () => {
    assert.throws(() => MerkleTree.empty().append(invalid), RangeError);
  });

  test(`CRY-10 fromLeaves rejects non-canonical leaf ${invalid}`, () => {
    assert.throws(() => MerkleTree.fromLeaves([invalid]), RangeError);
  });

  test(`CRY-10 set rejects non-canonical leaf ${invalid}`, () => {
    const tree = MerkleTree.fromLeaves([1n]);
    assert.throws(() => tree.set(0, invalid), RangeError);
  });

  test(`CRY-10 rootFromPath rejects non-canonical leaf ${invalid}`, () => {
    assert.throws(() => rootFromPath(invalid, 0, zeros.slice(0, 32)), RangeError);
  });

  test(`CRY-10 rootFromPath rejects non-canonical sibling ${invalid}`, () => {
    const siblings = zeros.slice(0, 32);
    siblings[31] = invalid;
    assert.throws(() => rootFromPath(0n, 0, siblings), RangeError);
  });
}

for (const index of [-1, 0.5, capacity, NaN, Infinity, -Infinity]) {
  for (const operation of ["leaf", "path", "set", "rootFromPath"] as const) {
    test(`CRY-10 ${operation} rejects index ${index}`, () => {
      const tree = MerkleTree.fromLeaves([1n]);
      const call = () => {
        if (operation === "set") return tree.set(index, 0n);
        if (operation === "rootFromPath") return rootFromPath(1n, index, zeros.slice(0, 32));
        return tree[operation](index);
      };
      assert.throws(call, RangeError);
    });
  }
}

for (const size of [0, 1]) {
  test(`CRY-10 set rejects index equal to size ${size}`, () => {
    const tree = MerkleTree.fromLeaves(firstLeaves.slice(0, size));
    assert.throws(() => tree.set(size, 0n), RangeError);
  });
}

test("CRY-10 set rejects an index beyond size", () => {
  assert.throws(() => MerkleTree.fromLeaves([1n]).set(2, 0n), RangeError);
});

test("CRY-10 append rejects a full tree", () => {
  const tree = MerkleTree.empty();
  // Reach the capacity guard without allocating four billion leaves.
  Reflect.set(tree, "leafCount", capacity);
  assert.throws(() => tree.append(1n), RangeError);
});

for (const length of [31, 33]) {
  test(`CRY-10 rootFromPath rejects ${length} siblings`, () => {
    assert.throws(() => rootFromPath(0n, 0, Array<bigint>(length).fill(0n)), RangeError);
  });
}
