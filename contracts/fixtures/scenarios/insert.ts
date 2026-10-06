import assert from "node:assert/strict";
import {
  commitment, deriveNoteSecrets, insertWitness, labelFor, MerkleTree, precommitment,
} from "@zbase-cardano/crypto";
import type { InsertSlot } from "@zbase-cardano/crypto";
import {
  bytes, configDatum, genesisDatum, int, list, m0Config, outputReference, poolDatum,
  proof, proveCached, samples,
} from "../lib.js";
import type { ConfigDatum, FixtureConstant, FixtureModule, OutputReference } from "../lib.js";

interface Deposit {
  reference: OutputReference;
  refund: Uint8Array;
  gross: bigint;
  precommitment: bigint;
}

interface Scenario {
  name: string;
  leaves: number;
  queued: number;
  flush: number;
  amounts: bigint[];
  config?: ConfigDatum;
  wrong?: "value" | "order";
}

export default async function build(): Promise<FixtureModule> {
  // Fixed, public test material. These notes must never hold real funds.
  const seed = new Uint8Array(32).fill(73);
  const note = (index: number) => ({
    value: 7_000_000n, label: 17n, ...deriveNoteSecrets(seed, index),
  });
  const scenarios: Scenario[] = [
    { name: "one_deposit", leaves: 0, queued: 0, flush: 0, amounts: [10_000_000n] },
    { name: "four_deposits", leaves: 3, queued: 0, flush: 0,
      amounts: [10_000_000n, 12_000_000n, 19_000_000n, 25_000_000n] },
    { name: "one_note", leaves: 3, queued: 1, flush: 1, amounts: [] },
    { name: "four_notes", leaves: 16, queued: 5, flush: 4, amounts: [] },
    { name: "two_notes_two_deposits", leaves: 3, queued: 2, flush: 2,
      amounts: [10_000_000n, 12_000_000n] },
    { name: "fee_bps", leaves: 3, queued: 0, flush: 0, amounts: [10_000_037n],
      config: { ...m0Config, depositFeeBps: 100n } },
    { name: "wrong_value", leaves: 0, queued: 0, flush: 0,
      amounts: [10_000_000n], wrong: "value" },
    { name: "wrong_order", leaves: 3, queued: 2, flush: 2,
      amounts: [10_000_000n, 12_000_000n], wrong: "order" },
  ];
  const constants: FixtureConstant[] = [];
  for (const scenario of scenarios) {
    const config = scenario.config ?? m0Config;
    const tree = MerkleTree.empty();
    const roots = [tree.root];
    for (let i = 0; i < scenario.leaves; i += 1) {
      tree.append(commitment(note(i)));
      roots.unshift(tree.root);
    }
    const queue = Array.from({ length: scenario.queued }, (_, i) => commitment(note(20 + i)));
    const datum = {
      ...genesisDatum, roots: roots.slice(0, 16), size: BigInt(tree.size), queue,
      feesAccrued: scenario.name === "fee_bps" ? 123_456n : 0n,
    };
    // Deliberately unsorted references make a sorting regression observable.
    const txBytes = [0xee, 0xbb, 0xdd, 0xcc];
    const indexes = [2, 3, 1, 0];
    const refunds = [samples.keyHash1, samples.keyHash2, samples.keyHash3, samples.keyHash4];
    const deposits: Deposit[] = scenario.amounts.map((gross, i) => {
      const secrets = deriveNoteSecrets(seed, 40 + i);
      return {
        reference: { txId: new Uint8Array(32).fill(txBytes[i]!), outputIndex: indexes[i]! },
        refund: refunds[i]!, gross, precommitment: precommitment(secrets.nullifier, secrets.secret),
      };
    });
    const fees = deposits.map(({ gross }) => gross * config.depositFeeBps / 10_000n);
    const depositSlots: InsertSlot[] = deposits.map((deposit, i) => ({
      kind: "deposit", value: deposit.gross - fees[i]! - config.crankFee,
      label: labelFor({ poolId: samples.poolId, ...deposit.reference, refundKeyHash: deposit.refund }),
      precommitment: deposit.precommitment,
    }));
    const noteSlots: InsertSlot[] = queue.slice(0, scenario.flush).map((commitment) => ({ kind: "note", commitment }));
    const slots = [...noteSlots, ...depositSlots];
    let proofSlots = slots;
    if (scenario.wrong === "value") {
      const slot = depositSlots[0]!;
      assert.equal(slot.kind, "deposit");
      proofSlots = [{ ...slot, value: slot.value + 1n }];
    } else if (scenario.wrong === "order") {
      proofSlots = [...depositSlots, ...noteSlots];
    }
    const witness = insertWitness({ tree, slots: proofSlots });
    const result = await proveCached("insert", scenario.name, "insert", witness.input);
    assert.deepEqual(result.publicInputs, witness.publicInputs, `${scenario.name}: public signal order`);
    const expectedSlots = slots.map((slot) => slot.kind === "note"
      ? [0n, 0n, slot.commitment] : [slot.value, slot.label, slot.precommitment]);
    while (expectedSlots.length < 4) expectedSlots.push([0n, 0n, 0n]);
    const outDatum = {
      ...datum, roots: [witness.newRoot, ...datum.roots].slice(0, 16),
      size: datum.size + BigInt(slots.length), queue: queue.slice(scenario.flush),
      feesAccrued: datum.feesAccrued + fees.reduce((sum, fee) => sum + fee, 0n),
    };
    const balanceIn = 6_000_000n + BigInt(scenario.leaves + scenario.queued) * 7_000_000n + datum.feesAccrued;
    const balanceOut = balanceIn + deposits.reduce((sum, deposit) => sum + deposit.gross - config.crankFee, 0n);
    const add = (suffix: string, type: string, expression: string) => {
      constants.push({ name: `${scenario.name}_${suffix}`, type, expression });
    };
    add("datum", "PoolDatum", poolDatum(datum));
    add("out_datum", "PoolDatum", poolDatum(outDatum));
    add("config", "ConfigDatum", configDatum(config));
    add("flush", "Int", int(scenario.flush));
    add("balance_in", "Int", int(balanceIn));
    add("balance_out", "Int", int(balanceOut));
    add("deposits", "List<(OutputReference, DepositDatum, Int)>", list(deposits.map((deposit) =>
      `(${outputReference(deposit.reference)}, DepositDatum { precommitment: ${int(deposit.precommitment)}, refund: ${bytes(deposit.refund)} }, ${int(deposit.gross)})`)));
    add("slots", "List<List<Int>>", list(expectedSlots.map((slot) => list(slot.map(int)))));
    add("proof", "groth16.Proof", proof(result.proof));
    add("public_inputs", "List<Int>", list(result.publicInputs.map(int)));
  }
  return {
    uses: ["use cardano/address.{Address, VerificationKey}", "use cardano/transaction.{OutputReference}",
      "use zbase/groth16", "use zbase/types.{ConfigDatum, DepositDatum, PoolDatum}"],
    constants,
  };
}
