import { assertCanonical } from "../field.js";
import { commitment, nullifierHash } from "../note.js";
import type { Note } from "../note.js";
import type { MerkleTree } from "../tree.js";

export type RagequitCircuitInput = Record<string, string | string[]>;

export interface RagequitWitness {
  input: RagequitCircuitInput;
  publicInputs: bigint[]; // On-chain order: [nullifierHash, stateRoot, value, label].
  nullifierHash: bigint;
  stateRoot: bigint;
}

export function ragequitWitness(a: { note: Note; stateTree: MerkleTree; stateIndex: number }): RagequitWitness {
  const { note, stateTree, stateIndex } = a;
  // Name the note field before the generic hash helpers can report a hash argument.
  assertCanonical(note.value, "value");
  assertCanonical(note.label, "label");
  assertCanonical(note.nullifier, "nullifier");
  assertCanonical(note.secret, "secret");
  const leaf = commitment(note);
  if (stateTree.leaf(stateIndex) !== leaf) {
    throw new Error("stateIndex leaf does not match commitment(note)");
  }

  const stateRoot = assertCanonical(stateTree.root, "stateRoot");
  const { siblings } = stateTree.path(stateIndex);
  const hash = nullifierHash(note.nullifier);
  return {
    input: {
      stateRoot: stateRoot.toString(),
      value: note.value.toString(),
      label: note.label.toString(),
      nullifier: note.nullifier.toString(),
      secret: note.secret.toString(),
      siblings: siblings.map((sibling, index) => assertCanonical(sibling, `siblings[${index}]`).toString()),
      index: stateIndex.toString(),
    },
    publicInputs: [hash, stateRoot, note.value, note.label],
    nullifierHash: hash,
    stateRoot,
  };
}
