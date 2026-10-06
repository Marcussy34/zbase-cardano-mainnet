import { assertCanonical } from "../field.js";
import { h3 } from "../poseidon.js";
import { TREE_DEPTH } from "../tree.js";
import type { MerkleTree } from "../tree.js";

export const INSERT_BATCH = 4;
export type InsertSlot =
  | { kind: "note"; commitment: bigint }
  | { kind: "deposit"; value: bigint; label: bigint; precommitment: bigint };
/** Every value as a decimal string, keyed by the circuit's input signal names. */
export type InsertCircuitInput = Record<string, string | string[] | string[][]>;
export interface InsertWitness {
  input: InsertCircuitInput;
  // 15 values: oldRoot, newRoot, startIndex, then v, l, x per slot.
  publicInputs: bigint[];
  oldRoot: bigint;
  newRoot: bigint;
  startIndex: number;
  leaves: bigint[];
  // The argument tree is not mutated.
  tree: MerkleTree;
}

/** The leaf a slot adds: the commitment for a note, H3(value, label, precommitment) for a deposit. */
export function slotLeaf(slot: InsertSlot): bigint {
  if (slot.kind === "note") {
    assertCanonical(slot.commitment, "note commitment");
    if (slot.commitment === 0n) throw new Error("note commitment must not be zero");
    return slot.commitment;
  }
  assertCanonical(slot.value, "deposit value");
  assertCanonical(slot.label, "deposit label");
  assertCanonical(slot.precommitment, "deposit precommitment");
  if (slot.value >= 1n << 64n) throw new Error("deposit value must fit in 64 bits");
  if (slot.label === 0n) throw new Error("deposit label must not be zero");
  if (slot.precommitment === 0n) throw new Error("deposit precommitment must not be zero");
  return h3(slot.value, slot.label, slot.precommitment);
}

export function insertWitness(a: { tree: MerkleTree; slots: InsertSlot[] }): InsertWitness {
  if (a.slots.length === 0 || a.slots.length > INSERT_BATCH) {
    throw new Error(`slots must contain between 1 and ${INSERT_BATCH} entries`);
  }
  if (a.tree.size + a.slots.length > 2 ** TREE_DEPTH) {
    throw new Error("tree has no room for the requested slots");
  }
  const leaves = a.slots.map(slotLeaf);
  const tree = a.tree.clone();
  const startIndex = a.tree.size;
  const oldRoot = tree.root;
  const slots: bigint[][] = [];
  const siblings: string[][] = [];
  for (const [i, slot] of a.slots.entries()) {
    slots.push(slot.kind === "note" ? [0n, 0n, slot.commitment] : [slot.value, slot.label, slot.precommitment]);
    // Each path must use the root after the preceding slot was appended.
    siblings.push(tree.path(tree.size).siblings.map(String));
    tree.append(leaves[i]!);
  }
  while (slots.length < INSERT_BATCH) {
    slots.push([0n, 0n, 0n]);
    siblings.push(Array<string>(TREE_DEPTH).fill("0"));
  }
  const newRoot = tree.root;
  const publicInputs = [oldRoot, newRoot, BigInt(startIndex), ...slots.flat()];
  return {
    input: { oldRoot: String(oldRoot), newRoot: String(newRoot), startIndex: String(startIndex),
      slots: slots.map((slot) => slot.map(String)), siblings },
    publicInputs, oldRoot, newRoot, startIndex, leaves, tree,
  };
}
