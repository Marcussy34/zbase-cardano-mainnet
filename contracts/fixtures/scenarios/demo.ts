import assert from "node:assert/strict";
import { Trie } from "@aiken-lang/merkle-patricia-forestry";
import {
  commitment, contextFor, deriveNoteSecrets, insertWitness, labelFor, MerkleTree,
  nullifierHash, nullifierKey, precommitment, ragequitWitness, spendWitness,
} from "@zbase-cardano/crypto";
import type { SettleIntent } from "@zbase-cardano/crypto";
import {
  bytes, int, list, m0Config, outputReference, proof, proveCached, samples, settleIntent, trieProof,
} from "../lib.js";
import type { FixtureConstant, FixtureModule } from "../lib.js";

export default async function build(): Promise<FixtureModule> {
  // This seed is public test data. Never use these notes with real funds.
  const seed = new Uint8Array(32).fill(42);
  const secrets = deriveNoteSecrets(seed, 0);
  const changeSecrets = deriveNoteSecrets(seed, 1);
  const depositRef = samples.outputReference2;
  const refund = samples.keyHash1;
  const gross = 10_000_000n;
  const depositFee = gross * m0Config.depositFeeBps / 10_000n;
  const creditedValue = gross - depositFee - m0Config.crankFee;
  const label = labelFor({ poolId: samples.poolId, ...depositRef, refundKeyHash: refund });
  const note = { value: creditedValue, label, ...secrets };
  const pre = precommitment(note.nullifier, note.secret);
  const inserted = insertWitness({ tree: MerkleTree.empty(), slots: [
    { kind: "deposit", value: note.value, label, precommitment: pre },
  ] });
  const insert = await proveCached("demo", "insert", "insert", inserted.input);
  assert.deepEqual(insert.publicInputs, inserted.publicInputs, "Insert public signal order");

  const aspTree = MerkleTree.fromLeaves([label]);
  const withdrawn = 3_000_000n;
  const paid = 2_500_000n;
  const intent: SettleIntent = {
    poolId: samples.poolId,
    payouts: [{ address: samples.payoutAddress, amount: paid, datumHash: null }],
    relayer: null, validUntil: 1_800_000_000_000n,
  };
  const context = contextFor(intent);
  const spent = spendWitness({ note, stateTree: inserted.tree, stateIndex: 0, aspTree, aspIndex: 0,
    withdrawn, newNullifier: changeSecrets.nullifier, newSecret: changeSecrets.secret, context });
  const spend = await proveCached("demo", "spend", "spend", spent.input);
  assert.deepEqual(spend.publicInputs, spent.publicInputs, "Spend public signal order");
  const exited = ragequitWitness({ note, stateTree: inserted.tree, stateIndex: 0 });
  const ragequit = await proveCached("demo", "ragequit", "ragequit", exited.input);
  assert.deepEqual(ragequit.publicInputs, exited.publicInputs, "Ragequit public signal order");

  const key = Buffer.from(nullifierKey(spent.public.nullifierHash));
  const secondHash = nullifierHash(changeSecrets.nullifier);
  const secondKey = Buffer.from(nullifierKey(secondHash));
  assert.notDeepEqual(secondKey, key);
  const trie = new Trie();
  await trie.insert(key, Buffer.from([1]));
  // Inclusion after insertion doubles as an insertion proof from the old root.
  const firstProof = await trie.prove(key);
  const firstRoot = Buffer.from(trie.hash);
  assert.equal(firstProof.verify(false, key), null);
  assert.deepEqual(firstProof.verify(true, key), firstRoot);
  await trie.insert(secondKey, Buffer.from([1]));
  const secondProof = await trie.prove(secondKey);
  assert.deepEqual(secondProof.verify(false, secondKey), firstRoot);
  assert.deepEqual(secondProof.verify(true, secondKey), trie.hash);

  const constants: FixtureConstant[] = [];
  for (const [name, value] of Object.entries({
    gross, deposit_fee: depositFee, crank_fee: m0Config.crankFee, credited_value: creditedValue,
    label, precommitment: pre, commitment: commitment(note), old_root: inserted.oldRoot,
    state_root: inserted.newRoot, start_index: BigInt(inserted.startIndex), asp_root: aspTree.root,
    withdrawn, paid, valid_until: intent.validUntil, context,
    new_commitment: spent.public.newCommitment, change_value: spent.changeNote.value,
    nullifier_hash: spent.public.nullifierHash, second_nullifier_hash: secondHash,
  })) constants.push({ name, type: "Int", expression: int(value) });
  for (const [name, value] of Object.entries({
    refund, nullifier_key: key, second_nullifier_key: secondKey,
    nullifier_root_1: firstRoot, nullifier_root_2: trie.hash,
  })) constants.push({ name, type: "ByteArray", expression: bytes(value) });
  constants.push(
    { name: "deposit_ref", type: "OutputReference", expression: outputReference(depositRef) },
    { name: "intent", type: "SettleIntent", expression: settleIntent(intent) },
    { name: "trie_proof_1", type: "mpf.Proof", expression: trieProof(firstProof) },
    { name: "trie_proof_2", type: "mpf.Proof", expression: trieProof(secondProof) },
  );
  for (const [name, result] of [["insert", insert], ["spend", spend], ["ragequit", ragequit]] as const) {
    constants.push(
      { name: `${name}_proof`, type: "groth16.Proof", expression: proof(result.proof) },
      { name: `${name}_public_inputs`, type: "List<Int>", expression: list(result.publicInputs.map(int)) },
    );
  }
  return {
    uses: ["use aiken/merkle_patricia_forestry as mpf", "use aiken/merkle_patricia_forestry.{Leaf}",
      "use cardano/address.{Address, VerificationKey}", "use cardano/transaction.{OutputReference}",
      "use zbase/groth16", "use zbase/types.{Payout, SettleIntent}"], constants,
  };
}
