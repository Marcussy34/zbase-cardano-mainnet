import { assertCanonical } from "./field.js";
import { h2 } from "./poseidon.js";

export const TREE_DEPTH = 32;
const TREE_CAPACITY = 2 ** TREE_DEPTH;
export type Hash2 = (a: bigint, b: bigint) => bigint;

function zeroHashes(hash: Hash2): readonly bigint[] {
  const zeros = [0n];
  for (let level = 0; level < TREE_DEPTH; level += 1) {
    zeros.push(hash(zeros[level]!, zeros[level]!));
  }
  return Object.freeze(zeros);
}

export const ZERO_HASHES: readonly bigint[] = zeroHashes(h2);

export interface MerklePath {
  siblings: bigint[];
  indexBits: number[];
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= TREE_CAPACITY) {
    throw new RangeError("index must be an integer satisfying 0 <= index < 2^32");
  }
}

export class MerkleTree {
  private readonly hash: Hash2;
  private readonly zeros: readonly bigint[];
  private nodes: Map<number, bigint>[];
  private leafCount = 0;

  private constructor(hash: Hash2, zeros: readonly bigint[]) {
    this.hash = hash;
    this.zeros = zeros;
    this.nodes = Array.from({ length: TREE_DEPTH + 1 }, () => new Map<number, bigint>());
  }

  static empty(hash: Hash2 = h2): MerkleTree {
    return new MerkleTree(hash, hash === h2 ? ZERO_HASHES : zeroHashes(hash));
  }

  static fromLeaves(leaves: readonly bigint[], hash: Hash2 = h2): MerkleTree {
    const tree = MerkleTree.empty(hash);
    for (const leaf of leaves) tree.append(leaf);
    return tree;
  }

  append(leaf: bigint): number {
    assertCanonical(leaf, "leaf");
    if (this.leafCount >= TREE_CAPACITY) {
      throw new RangeError("cannot append to a full tree");
    }
    const index = this.leafCount;
    this.writeLeaf(index, leaf);
    this.leafCount += 1;
    return index;
  }

  set(index: number, leaf: bigint): void {
    assertIndex(index);
    assertCanonical(leaf, "leaf");
    if (index >= this.leafCount) {
      throw new RangeError("set index must be less than size");
    }
    this.writeLeaf(index, leaf);
  }

  get size(): number {
    return this.leafCount;
  }

  get root(): bigint {
    return this.node(TREE_DEPTH, 0);
  }

  leaf(index: number): bigint {
    assertIndex(index);
    return this.nodes[0]!.get(index) ?? 0n;
  }

  path(index: number): MerklePath {
    assertIndex(index);
    const siblings: bigint[] = [];
    const indexBits: number[] = [];
    let position = index;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const bit = position % 2;
      indexBits.push(bit);
      siblings.push(this.node(level, position + (bit === 0 ? 1 : -1)));
      // Arithmetic keeps indexes above 2^31 unsigned.
      position = Math.floor(position / 2);
    }
    return { siblings, indexBits };
  }

  clone(): MerkleTree {
    const clone = new MerkleTree(this.hash, this.zeros);
    clone.leafCount = this.leafCount;
    clone.nodes = this.nodes.map((level) => new Map(level));
    return clone;
  }

  private writeLeaf(index: number, leaf: bigint): void {
    this.nodes[0]!.set(index, leaf);
    // Defer hashing so a batch of appends computes each shared ancestor once.
    let position = index;
    for (let level = 1; level <= TREE_DEPTH; level += 1) {
      position = Math.floor(position / 2);
      this.nodes[level]!.delete(position);
    }
  }

  private node(level: number, index: number): bigint {
    if (index * 2 ** level >= this.leafCount) return this.zeros[level]!;
    const cache = this.nodes[level]!;
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    if (level === 0) return 0n;
    const value = this.hash(
      this.node(level - 1, index * 2),
      this.node(level - 1, index * 2 + 1),
    );
    cache.set(index, value);
    return value;
  }
}

/** Recomputes a root from a leaf, its index, and its 32 siblings. */
export function rootFromPath(
  leaf: bigint,
  index: number,
  siblings: readonly bigint[],
  hash: Hash2 = h2,
): bigint {
  assertIndex(index);
  assertCanonical(leaf, "leaf");
  if (siblings.length !== TREE_DEPTH) {
    throw new RangeError("a Merkle path must have exactly 32 siblings");
  }
  for (const sibling of siblings) assertCanonical(sibling, "sibling");
  let node = leaf;
  let position = index;
  for (const sibling of siblings) {
    node = position % 2 === 0 ? hash(node, sibling) : hash(sibling, node);
    position = Math.floor(position / 2);
  }
  return node;
}
