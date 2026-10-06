import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { IndexerApi } from '@zbase-cardano/api';
import {
  MerkleTree, NETWORKS, commitment, contextFor, deriveNoteSecrets, insertWitness,
  precommitment, spendWitness, type Note,
} from '@zbase-cardano/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zbase-cardano/prover';
import {
  buildAspUpdate, buildDeposit, buildSettle, encodeDepositDatum, enterpriseAddress, keyHash,
  nullifierInsertion, planInsert, readAsp, readConfig, readDeposits, readPool,
} from '@zbase-cardano/txlib';
import { startDevnet } from '@zbase-cardano/txlib/testing/devnet';
import { Crank } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
after(shutdown);

test('CRK-01, CRK-02, CRK-03: real proof crank rounds', {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { chain, ctx, keys, run } = await startDevnet();
  const network = ctx.deployment.network;
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const payer = (seed: Uint8Array) => ({ address: enterpriseAddress(seed, network) });
  let tree = MerkleTree.empty();
  let leaves: bigint[] = [];
  const indexer: IndexerApi = {
    async getPool() {
      const [pool, config, asp, tip] = await Promise.all([readPool(ctx), readConfig(ctx), readAsp(ctx), chain.getTip()]);
      const { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee } = config.datum;
      return { poolId: ctx.deployment.poolId, asset: 'lovelace', ...pool.datum, aspRoot: asp.datum.root,
        config: { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee },
        tip: { slot: tip.slot, hash: tip.blockHash } };
    },
    async getLeaves(from, limit) {
      // Short pages exercise pagination even with only a few leaves.
      return { from, leaves: leaves.slice(from, from + Math.min(limit, 1)), size: leaves.length,
        root: MerkleTree.fromLeaves(leaves).root };
    },
    async getAspLeaves(from) { return { from, leaves: [], root: (await readAsp(ctx)).datum.root }; },
    async getNullifiers(from) { return { from, nullifiers: [] }; },
    async getDeposits() {
      return (await readDeposits(ctx)).map(({ utxo, datum }) => ({ ...utxo.ref, gross: utxo.value.lovelace,
        precommitment: datum.precommitment, refundKeyHash: datum.refund, status: 'pending' as const,
        value: null, label: null, leafIndex: null }));
    },
  };
  const crank = new Crank({ ctx, indexer, seed: keys.crank, artifacts: await loadDevArtifacts('insert', repoRoot) });
  let submissions = 0;
  const submit = chain.submit.bind(chain);
  chain.submit = async cbor => { submissions++; return submit(cbor); };
  const secrets = keys.users.map(key => deriveNoteSecrets(key, 0));
  const deposit = async (user: number, amount: bigint) => {
    const key = keys.users[user]!;
    const note = secrets[user]!;
    await run(await buildDeposit(ctx, { payer: payer(key), amount,
      precommitment: precommitment(note.nullifier, note.secret), refundKeyHash: hex(keyHash(key)) }), [key]);
  };
  async function insert() {
    const pool = await readPool(ctx);
    const plan = planInsert({ poolId: ctx.deployment.poolId, pool, config: (await readConfig(ctx)).datum,
      deposits: await readDeposits(ctx) });
    assert.ok(plan);
    const expected = insertWitness({ tree, slots: plan.slots });
    const result = await crank.tick();
    assert.ok(result);
    assert.deepEqual({ notes: result.notes, deposits: result.deposits }, { notes: plan.flush, deposits: plan.deposits.length });
    assert.equal((await readPool(ctx)).datum.size, tree.size, 'submission does not imply confirmation');
    const block = chain.mineBlock();
    assert.ok(block.txIds.includes(result.txId));
    leaves.push(...expected.leaves);
    tree = expected.tree;
    const next = await readPool(ctx);
    assert.equal(next.datum.roots[0], tree.root);
    assert.equal(next.datum.size, tree.size);
    return plan;
  }
  await t.test('CRK-01: an empty round submits nothing', async () => {
    assert.equal(await crank.tick(), null);
    assert.equal(submissions, 0);
  });
  let firstNote: Note;
  let firstIndex = 0;
  await t.test('CRK-02: two deposits enter the on-chain tree', async () => {
    await deposit(0, 20_000_000n);
    await deposit(1, 20_000_000n);
    const plan = await insert();
    assert.equal(plan.deposits.length, 2);
    firstIndex = plan.deposits.findIndex(d => d.datum.refund === hex(keyHash(keys.users[0]!)));
    firstNote = { ...secrets[0]!, value: plan.credited[firstIndex]!.value, label: plan.credited[firstIndex]!.label };
  });
  await t.test('CRK-01: a behind or inconsistent indexer submits nothing', async () => {
    await deposit(2, 10_000_000n);
    const before = submissions;
    const completeLeaves = leaves;
    leaves = [];
    assert.equal(await crank.tick(), null);
    leaves = completeLeaves.map(leaf => leaf + 1n);
    assert.equal(await crank.tick(), null);
    leaves = completeLeaves;
    assert.equal(submissions, before);
  });
  await t.test('CRK-02: queued change precedes a pending deposit', async () => {
    const aspTree = MerkleTree.fromLeaves([firstNote.label]);
    await run(await buildAspUpdate(ctx, { payer: payer(keys.asp), root: aspTree.root,
      signers: [hex(keyHash(keys.asp))] }), [keys.asp]);
    const intent = { poolId: Buffer.from(ctx.deployment.poolId, 'hex'), relayer: keyHash(keys.relayer),
      payouts: [{ address: { payment: { kind: 'key' as const, hash: keyHash(keys.users[0]!) }, stake: null },
        amount: 2_000_000n, datumHash: null }], validUntil: BigInt((await chain.getTip()).time + 300_000) };
    const fresh = deriveNoteSecrets(keys.users[0]!, 1);
    const witness = spendWitness({ note: firstNote, stateTree: tree, stateIndex: firstIndex, aspTree, aspIndex: 0,
      withdrawn: 3_000_000n, newNullifier: fresh.nullifier, newSecret: fresh.secret, context: contextFor(intent) });
    const proof = await prove(await loadDevArtifacts('spend', repoRoot), witness.input);
    const trie = await nullifierInsertion([], witness.public.nullifierHash);
    await run(await buildSettle(ctx, { payer: payer(keys.relayer), pool: await readPool(ctx), proof: proof.cardano,
      ...witness.public, withdrawn: 3_000_000n, intent, nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot }), [keys.relayer]);
    const start = tree.size;
    const plan = await insert();
    assert.equal(plan.flush, 1);
    assert.equal(plan.deposits.length, 1);
    assert.equal(tree.leaf(start), commitment(witness.changeNote));
    assert.equal(plan.slots[0]!.kind, 'note');
    assert.equal(plan.slots[1]!.kind, 'deposit');
    assert.deepEqual((await readPool(ctx)).datum.queue, []);
  });
  await t.test('CRK-03: a below-minimum deposit and missing datum do not stall a valid deposit', async () => {
    const address = ctx.deployment.scripts.deposit.address;
    const invalid = chain.addUtxo({ address, value: { lovelace: 2_000_000n, assets: {} },
      inlineDatum: encodeDepositDatum({ precommitment: 42n, refund: hex(keyHash(keys.users[0]!)) }), datumHash: null, scriptRef: null });
    const noDatum = chain.addUtxo({ address, value: { lovelace: 10_000_000n, assets: {} },
      inlineDatum: null, datumHash: null, scriptRef: null });
    await deposit(0, 10_000_000n);
    assert.equal((await insert()).deposits.length, 1);
    assert.equal((await chain.getUtxos([invalid, noDatum])).length, 2);
    const before = submissions;
    assert.equal(await crank.tick(), null);
    assert.equal(submissions, before);
  });
});
