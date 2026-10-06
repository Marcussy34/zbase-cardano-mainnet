import { assertCanonical } from "../field.js";
import { commitment, nullifierHash } from "../note.js";
import type { Note } from "../note.js";
import { TREE_DEPTH } from "../tree.js";
import type { MerkleTree } from "../tree.js";

export interface SpendArgs {
  note: Note;
  stateTree: MerkleTree;
  stateIndex: number;
  aspTree: MerkleTree;
  aspIndex: number;
  withdrawn: bigint;
  newNullifier: bigint;
  newSecret: bigint;
  context: bigint;
}

/** Every value as a decimal string, keyed by the circuit's input signal names. */
export type SpendCircuitInput = Record<string, string | string[]>;

export interface SpendPublic {
  newCommitment: bigint;
  nullifierHash: bigint;
  withdrawnValue: bigint;
  stateRoot: bigint;
  aspRoot: bigint;
  context: bigint;
}

export interface SpendWitness {
  input: SpendCircuitInput;
  public: SpendPublic;
  /** On-chain order: newCommitment, nullifierHash, withdrawnValue, stateRoot, aspRoot, context. */
  publicInputs: bigint[];
  changeNote: Note;
}

export function spendWitness(a: SpendArgs): SpendWitness {
  for (const field of ["value", "label", "nullifier", "secret"] as const) {
    assertCanonical(a.note[field], `note.${field}`);
  }
  for (const field of ["withdrawn", "newNullifier", "newSecret", "context"] as const) {
    assertCanonical(a[field], field);
  }
  if (a.note.label === 0n) throw new Error("note.label must not be zero");
  if (a.withdrawn > a.note.value) throw new Error("withdrawn must not exceed note.value");
  if (a.newNullifier === a.note.nullifier) {
    throw new Error("newNullifier must differ from note.nullifier");
  }
  for (const field of ["stateIndex", "aspIndex"] as const) {
    if (!Number.isInteger(a[field]) || a[field] < 0 || a[field] >= 2 ** TREE_DEPTH) {
      throw new Error(`${field} must be an integer satisfying 0 <= index < 2^${TREE_DEPTH}`);
    }
  }
  // commitment also enforces the note's 64-bit value bound before deriving the change.
  if (a.stateTree.leaf(a.stateIndex) !== commitment(a.note)) {
    throw new Error("stateTree leaf at stateIndex must equal commitment(note)");
  }
  if (a.aspTree.leaf(a.aspIndex) !== a.note.label) {
    throw new Error("aspTree leaf at aspIndex must equal note.label");
  }
  const stateSiblings = a.stateTree.path(a.stateIndex).siblings;
  const aspSiblings = a.aspTree.path(a.aspIndex).siblings;
  for (const [name, siblings] of [["stateSiblings", stateSiblings], ["aspSiblings", aspSiblings]] as const) {
    siblings.forEach((sibling, index) => assertCanonical(sibling, `${name}[${index}]`));
  }
  const stateRoot = assertCanonical(a.stateTree.root, "stateRoot");
  const aspRoot = assertCanonical(a.aspTree.root, "aspRoot");
  const changeNote: Note = {
    value: a.note.value - a.withdrawn,
    label: a.note.label,
    nullifier: a.newNullifier,
    secret: a.newSecret,
  };
  const result: SpendPublic = {
    newCommitment: commitment(changeNote),
    nullifierHash: nullifierHash(a.note.nullifier),
    withdrawnValue: a.withdrawn,
    stateRoot,
    aspRoot,
    context: a.context,
  };
  return {
    input: {
      withdrawnValue: a.withdrawn.toString(),
      stateRoot: result.stateRoot.toString(),
      aspRoot: result.aspRoot.toString(),
      context: a.context.toString(),
      label: a.note.label.toString(),
      existingValue: a.note.value.toString(),
      existingNullifier: a.note.nullifier.toString(),
      existingSecret: a.note.secret.toString(),
      newNullifier: a.newNullifier.toString(),
      newSecret: a.newSecret.toString(),
      stateSiblings: stateSiblings.map(String),
      stateIndex: a.stateIndex.toString(),
      aspSiblings: aspSiblings.map(String),
      aspIndex: a.aspIndex.toString(),
    },
    public: result,
    publicInputs: [result.newCommitment, result.nullifierHash, result.withdrawnValue,
      result.stateRoot, result.aspRoot, result.context],
    changeNote,
  };
}
