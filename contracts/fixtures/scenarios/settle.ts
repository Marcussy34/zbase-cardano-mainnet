import assert from "node:assert/strict";
import { Trie } from "@aiken-lang/merkle-patricia-forestry";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  R, commitment, contextFor, deriveNoteSecrets, labelFor, MerkleTree, nullifierKey, spendWitness,
} from "@zx402/crypto";
import type { Payout, SettleIntent } from "@zx402/crypto";
import {
  bytes, configDatum, emptyNullifierRoot, emptyStateRoot, int, list, m0Config,
  poolDatum, proof, proveCached, samples, settleIntent, trieProof,
} from "../lib.js";
import type { CachedProof, FixtureConstant, FixtureModule, PoolDatum } from "../lib.js";

// Select real keys with two sibling nibbles at each of five levels. This gives
// the full Branch cost of a million-entry trie without storing a million keys.
async function budgetTrie(key: Buffer): Promise<{ trie: Trie; entries: number }> {
  const target = Buffer.from(blake2b(key, { dkLen: 32 })).toString("hex");
  const siblings = Array.from({ length: 5 }, () => new Set<string>());
  const pairs: { key: Buffer; value: Buffer }[] = [];
  for (let candidate = 1n; pairs.length < 4096 || siblings.some((set) => set.size < 2); candidate++) {
    const other = Buffer.from(nullifierKey(candidate));
    const path = Buffer.from(blake2b(other, { dkLen: 32 })).toString("hex");
    let depth = 0;
    while (depth < 5 && path[depth] === target[depth]) depth++;
    if (depth === 5) continue;
    const set = siblings[depth]!;
    if (pairs.length < 4096 || (set.size < 2 && !set.has(path[depth]!))) {
      pairs.push({ key: other, value: Buffer.from([1]) });
      set.add(path[depth]!);
    }
  }
  return { trie: await Trie.fromList(pairs), entries: pairs.length };
}

export default async function build(): Promise<FixtureModule> {
  // Public, fixed test seed. These notes must never hold real funds.
  const seed = new Uint8Array(32).fill(63);
  const label = labelFor({ poolId: samples.poolId, ...samples.outputReference2, refundKeyHash: samples.keyHash1 });
  const note = { value: 9_700_000n, label, ...deriveNoteSecrets(seed, 0) };
  const change = deriveNoteSecrets(seed, 1);
  const stateTree = MerkleTree.fromLeaves([
    commitment({ value: 5_000_000n, label: 111n, ...deriveNoteSecrets(seed, 2) }),
    commitment(note),
    commitment({ value: 6_000_000n, label: 222n, ...deriveNoteSecrets(seed, 3) }),
  ]);
  const aspTree = MerkleTree.fromLeaves([111n, label, 222n]);
  // Plutus Data integer 42 serialises to CBOR 182a in both runtimes.
  const datumHash = blake2b(Buffer.from("182a", "hex"), { dkLen: 32 });
  const single = (amount: bigint): Payout[] => [{ address: samples.payoutAddress, amount, datumHash: null }];
  const four: Payout[] = [
    ...single(2_000_000n),
    { address: { payment: { kind: "key", hash: samples.keyHash3 }, stake: { kind: "key", hash: samples.keyHash1 } }, amount: 2_000_000n, datumHash: null },
    { address: { payment: { kind: "script", hash: samples.scriptHash2 }, stake: null }, amount: 2_000_000n, datumHash },
    { address: samples.treasuryAddress, amount: 2_000_000n, datumHash: null },
  ];
  const constants: FixtureConstant[] = [
    { name: "payout_datum", type: "Int", expression: "42" },
    { name: "payout_datum_hash", type: "ByteArray", expression: bytes(datumHash) },
    { name: "state_index", type: "Int", expression: "1" },
    { name: "asp_index", type: "Int", expression: "1" },
  ];
  const trieConstructors = new Set<string>();
  const emitTrie = (value: Parameters<typeof trieProof>[0]): string => {
    const expression = trieProof(value);
    for (const constructor of ["Branch", "Fork", "Leaf", "Neighbor"]) {
      if (expression.includes(`${constructor} {`)) trieConstructors.add(constructor);
    }
    return expression;
  };
  const add = (name: string, type: string, expression: string): void => { constants.push({ name, type, expression }); };
  let partial: CachedProof | undefined;
  for (const name of ["partial", "full", "four_payouts", "zero_withdrawn", "alias", "budget"] as const) {
    const isFour = name === "four_payouts" || name === "budget";
    const withdrawn = name === "zero_withdrawn" ? 0n : name === "full" ? note.value : isFour ? 8_080_000n : 3_000_000n;
    const intent: SettleIntent = {
      poolId: samples.poolId,
      payouts: isFour ? four : single(name === "zero_withdrawn" ? 0n : name === "full" ? 9_000_000n : 2_500_000n),
      relayer: isFour || name === "full" ? samples.keyHash1 : null,
      validUntil: 1_800_000_000_000n,
    };
    const context = contextFor(intent);
    const witness = spendWitness({ note, stateTree, stateIndex: 1, aspTree, aspIndex: 1,
      withdrawn, newNullifier: change.nullifier, newSecret: change.secret, context });
    const result = name === "alias" ? partial! : await proveCached("settle", isFour ? "four_payouts" : name, "spend", witness.input);
    assert.deepEqual(result.publicInputs, witness.publicInputs, `${name} public signal order`);
    if (name === "partial") partial = result;
    const hash = result.publicInputs[1]! + (name === "alias" ? R : 0n);
    const publicInputs = [...result.publicInputs];
    publicInputs[1] = hash;
    // Bypass the SDK field guard only to model the on-chain alias attack.
    const key = name === "alias" ? Buffer.from(hash.toString(16).padStart(64, "0"), "hex") : Buffer.from(nullifierKey(hash));
    const { trie, entries } = name === "budget" ? await budgetTrie(key) : { trie: new Trie(), entries: 0 };
    const oldRoot = trie.hash === null ? emptyNullifierRoot : Buffer.from(trie.hash);
    await trie.insert(key, Buffer.from([1]));
    const insertion = await trie.prove(key);
    assert.deepEqual(insertion.verify(false, key) ?? emptyNullifierRoot, oldRoot);
    assert.deepEqual(insertion.verify(true, key), trie.hash);
    const steps = insertion.toJSON() as { type: string; skip: number }[];
    if (name === "budget") {
      assert.equal(steps.length, 5);
      assert(steps.every((step) => step.type === "branch" && step.skip === 0));
      const otherKey = Buffer.from(nullifierKey(1n));
      assert.notDeepEqual(otherKey, key);
      const otherProof = await trie.prove(otherKey);
      add("other_key_trie_proof", "mpf.Proof", emitTrie(otherProof));
      add("other_key_trie_bytes", "Int", int(otherProof.toCBOR().length));
    }
    const feeBps = isFour ? 100n : 0n;
    const paid = intent.payouts.reduce((sum, payout) => sum + payout.amount, 0n);
    const fee = paid * feeBps / 10_000n;
    assert(paid + fee <= withdrawn);
    if (isFour) assert.equal(paid + fee, withdrawn);
    const datum: PoolDatum = {
      roots: [stateTree.root, emptyStateRoot], size: 3n,
      queue: name === "budget" ? [101n, 102n, 103n, 104n, 105n, 106n, 107n] : [101n, 102n],
      nullifierRoot: oldRoot, feesAccrued: 17_000n,
    };
    const out: PoolDatum = { ...datum, queue: [...datum.queue, publicInputs[0]!], nullifierRoot: trie.hash, feesAccrued: datum.feesAccrued + fee };
    const prefix = (field: string): string => `${name}_${field}`;
    add(prefix("datum"), "PoolDatum", poolDatum(datum));
    add(prefix("out_datum"), "PoolDatum", poolDatum(out));
    add(prefix("config"), "ConfigDatum", configDatum({ ...m0Config, settleFeeBps: feeBps }));
    add(prefix("intent"), "SettleIntent", settleIntent(intent));
    add(prefix("proof"), "groth16.Proof", proof(result.proof));
    add(prefix("public_inputs"), "List<Int>", list(publicInputs.map(int)));
    add(prefix("trie_proof"), "mpf.Proof", emitTrie(insertion));
    for (const [field, value] of Object.entries({
      new_commitment: publicInputs[0]!, nullifier_hash: hash, withdrawn,
      state_root: stateTree.root, asp_root: aspTree.root, context,
      paid, fee, change_value: witness.changeNote.value,
      balance_in: 30_000_000n, balance_out: 30_000_000n - withdrawn + fee,
      trie_entries: entries, trie_steps: steps.length, trie_bytes: insertion.toCBOR().length,
    })) add(prefix(field), "Int", int(value));
  }
  return {
    uses: ["use aiken/merkle_patricia_forestry as mpf", `use aiken/merkle_patricia_forestry.{${[...trieConstructors].sort().join(", ")}}`,
      "use cardano/address.{Address, Inline, Script, VerificationKey}",
      "use zx402/groth16", "use zx402/types.{ConfigDatum, Payout, PoolDatum, SettleIntent}"],
    constants,
  };
}
