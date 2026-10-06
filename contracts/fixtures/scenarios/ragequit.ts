import assert from "node:assert/strict";
import { Trie } from "@aiken-lang/merkle-patricia-forestry";
import {
  commitment, deriveNoteSecrets, labelFor, MerkleTree, nullifierHash, nullifierKey,
  R, ragequitWitness, spendWitness,
} from "@zbase-cardano/crypto";
import type { Note } from "@zbase-cardano/crypto";
import {
  bytes, int, list, outputReference, poolDatum, proof, proveCached, samples, trieProof,
} from "../lib.js";
import type { CachedProof, FixtureConstant, FixtureModule, PoolDatum } from "../lib.js";

export default async function build(): Promise<FixtureModule> {
  // Public test seed only. No witness secrets are emitted or cached.
  const seed = new Uint8Array(32).fill(73);
  const depositRef = samples.outputReference3;
  const refund = samples.keyHash4;
  const label = labelFor({ poolId: samples.poolId, ...depositRef, refundKeyHash: refund });
  assert.notEqual(label, 0n);
  const note: Note = { value: 9_700_000n, label, ...deriveNoteSecrets(seed, 0) };
  const changeSecrets = deriveNoteSecrets(seed, 1);
  const filler = (index: number): Note => ({ value: 5_000_000n, label, ...deriveNoteSecrets(seed, index) });
  const tree = MerkleTree.fromLeaves([commitment(filler(2)), commitment(filler(3))]);
  const previousRoot = tree.root;
  const depositIndex = tree.append(commitment(note));
  assert.equal(depositIndex, 2);
  const exited = ragequitWitness({ note, stateTree: tree, stateIndex: depositIndex });
  const deposit = await proveCached("ragequit", "deposit_note", "ragequit", exited.input);
  assert.deepEqual(deposit.publicInputs, exited.publicInputs, "Deposit public signal order");

  // Derive the change through the spend witness so its value and label carry forward.
  const spent = spendWitness({ note, stateTree: tree, stateIndex: depositIndex,
    aspTree: MerkleTree.fromLeaves([label]), aspIndex: 0, withdrawn: 3_000_000n,
    newNullifier: changeSecrets.nullifier, newSecret: changeSecrets.secret, context: 0n });
  assert.equal(spent.changeNote.value, 6_700_000n);
  assert.equal(spent.changeNote.label, label);
  const changeTree = tree.clone();
  const changeIndex = changeTree.append(spent.public.newCommitment);
  assert.equal(changeIndex, 3);
  const changeExit = ragequitWitness({ note: spent.changeNote, stateTree: changeTree, stateIndex: changeIndex });
  const change = await proveCached("ragequit", "change_note", "ragequit", changeExit.input);
  assert.deepEqual(change.publicInputs, changeExit.publicInputs, "Change public signal order");

  const constants: FixtureConstant[] = [];
  const proofConstructors = new Set<string>();
  async function scenario(name: string, result: CachedProof, stateTree: MerkleTree,
    index: number, olderRoot: bigint, spentHashes: bigint[], hash = result.publicInputs[0]!) {
    const trie = new Trie();
    for (const spentHash of spentHashes) {
      await trie.insert(Buffer.from(nullifierKey(spentHash)), Buffer.from([1]));
    }
    const oldRoot = Buffer.from(trie.hash);
    // Deliberately bypass nullifierKey's range check only for the malicious alias.
    assert(hash >= 0n && hash < 2n ** 256n);
    const key = Buffer.from(hash.toString(16).padStart(64, "0"), "hex");
    await trie.insert(key, Buffer.from([1]));
    const insertion = await trie.prove(key);
    const newRoot = Buffer.from(trie.hash);
    assert.deepEqual(insertion.verify(false, key), oldRoot);
    assert.deepEqual(insertion.verify(true, key), newRoot);
    const datum: PoolDatum = {
      roots: [stateTree.root, olderRoot], size: BigInt(stateTree.size),
      queue: [commitment(filler(4))], nullifierRoot: oldRoot, feesAccrued: 123_456n,
    };
    const newDatum: PoolDatum = { ...datum, nullifierRoot: newRoot };
    const expression = trieProof(insertion);
    for (const constructor of ["Branch", "Fork", "Leaf", "Neighbor"]) {
      if (new RegExp(`\\b${constructor}\\b`).test(expression)) proofConstructors.add(constructor);
    }
    const [, stateRoot, value, noteLabel] = result.publicInputs;
    assert.equal(noteLabel, label);
    for (const [field, scalar] of Object.entries({
      nullifier_hash: hash, state_root: stateRoot!, value: value!, label, state_index: index,
    })) constants.push({ name: `${name}_${field}`, type: "Int", expression: int(scalar) });
    constants.push(
      { name: `${name}_datum`, type: "PoolDatum", expression: poolDatum(datum) },
      { name: `${name}_out_datum`, type: "PoolDatum", expression: poolDatum(newDatum) },
      { name: `${name}_deposit_ref`, type: "OutputReference", expression: outputReference(depositRef) },
      { name: `${name}_refund`, type: "ByteArray", expression: bytes(refund) },
      { name: `${name}_proof`, type: "groth16.Proof", expression: proof(result.proof) },
      { name: `${name}_public_inputs`, type: "List<Int>", expression: list([hash, stateRoot!, value!, label].map(int)) },
      { name: `${name}_trie_proof`, type: "mpf.Proof", expression },
    );
  }
  const previouslySpent = nullifierHash(deriveNoteSecrets(seed, 5).nullifier);
  await scenario("deposit_note", deposit, tree, depositIndex, previousRoot, [previouslySpent]);
  await scenario("change_note", change, changeTree, changeIndex, tree.root, [previouslySpent, exited.nullifierHash]);
  // Reuse the exact proof and all canonical public inputs except the nullifier hash.
  await scenario("alias", deposit, tree, depositIndex, previousRoot, [previouslySpent], exited.nullifierHash + R);
  return {
    uses: ["use aiken/merkle_patricia_forestry as mpf",
      `use aiken/merkle_patricia_forestry.{${[...proofConstructors].sort().join(", ")}}`,
      "use cardano/transaction.{OutputReference}", "use zbase/groth16", "use zbase/types.{PoolDatum}"],
    constants,
  };
}
