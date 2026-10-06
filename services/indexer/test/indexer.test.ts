import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiError, IndexerClient } from '@zbase-cardano/api';
import {
  MerkleTree, NETWORKS, commitment, contextFor, deriveNoteSecrets, h3, insertWitness,
  labelFor, precommitment, ragequitWitness, spendWitness, type Note, type SettleIntent,
} from '@zbase-cardano/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zbase-cardano/prover';
import {
  buildAspUpdate, buildDeposit, buildInsert, buildRagequit, buildRefund, buildSettle,
  enterpriseAddress, keyHash, nullifierInsertion, nullifierRoot, planInsert,
  readConfig, readDeposits, readPool, type ChainHistory, type DepositUtxo,
} from '@zbase-cardano/txlib';
import { startDevnet } from '@zbase-cardano/txlib/testing/devnet';
import { Indexer, serveIndexer } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
after(shutdown);

test('IDX-01: Init exposes genesis and validates pages without proving keys', async () => {
  const { chain, ctx } = await startDevnet();
  const indexer = new Indexer({ ctx, history: chain });
  await assert.rejects(indexer.getPool(), ApiError);
  assert.equal(await indexer.sync(), 1);
  const pool = await indexer.getPool();
  assert.equal(pool.poolId, ctx.deployment.poolId);
  assert.equal(pool.asset, 'lovelace');
  assert.equal(pool.size, 0);
  assert.deepEqual(pool.roots, [MerkleTree.empty().root]);
  assert.deepEqual(pool.queue, []);
  assert.equal(pool.nullifierRoot, '00'.repeat(32));
  assert.equal(pool.config.crankFee, 300_000n);
  assert.deepEqual(await indexer.getLeaves(0, 10), { from: 0, leaves: [], size: 0, root: pool.roots[0] });
  assert.deepEqual(await indexer.getNullifiers(0, 10), { from: 0, nullifiers: [] });
  assert.equal(await indexer.sync(), 0);
  await assert.rejects(indexer.getLeaves(-1, 1), ApiError);
  await assert.rejects(indexer.getNullifiers(0, 0), ApiError);
  pool.roots[0] = 1n;
  assert.notEqual((await indexer.getPool()).roots[0], 1n);
});

test('IDX-03: a tip change during an asynchronous refresh preserves the snapshot', async () => {
  const { chain, ctx } = await startDevnet();
  let changeTip = false;
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (changeTip) chain.mineBlock();
    return [];
  } });
  await indexer.sync();
  const before = await indexer.getPool();
  changeTip = true;
  await assert.rejects(indexer.sync(), /tip changed/i);
  assert.deepEqual(await indexer.getPool(), before);
  changeTip = false;
  await indexer.sync();
  assert.equal((await indexer.getPool()).tip.hash, (await chain.getTip()).blockHash);
});

test('IDX-01: ASP pages cap responses and reject unpublished leaves', async () => {
  const { chain, ctx, keys, run } = await startDevnet();
  const labels = Array.from({ length: 1_005 }, (_, i) => BigInt(i + 1));
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: () => labels });
  await indexer.sync();
  await assert.rejects(indexer.getAspLeaves(0, 1), error => error instanceof ApiError && error.code === 'stale_asp_root');
  await run(await buildAspUpdate(ctx, { payer: { address: enterpriseAddress(keys.asp, ctx.deployment.network) },
    root: MerkleTree.fromLeaves(labels).root, signers: [hex(keyHash(keys.asp))] }), [keys.asp]);
  await indexer.sync();
  assert.deepEqual((await indexer.getAspLeaves(0, 10_000)).leaves, labels.slice(0, 1_000));
  assert.deepEqual((await indexer.getAspLeaves(1_000, 10_000)).leaves, labels.slice(1_000));
  assert.deepEqual((await indexer.getAspLeaves(2_000, 10)).leaves, []);
});

test('IDX-01, IDX-02, IDX-03: replay the confirmed pool story', {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json',
}, async t => {
  const { chain, ctx, keys, run } = await startDevnet();
  chain.advanceSlots(NETWORKS[ctx.deployment.network].zeroSlot);
  const payer = (seed: Uint8Array) => ({ address: enterpriseAddress(seed, ctx.deployment.network) });
  const users = keys.users;
  const secrets = users.map(seed => deriveNoteSecrets(seed, 0));
  let labels: bigint[] = [];
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: () => labels });
  await indexer.sync();
  let tree = MerkleTree.empty();
  let notes: Note[] = [];
  let deposits: DepositUtxo[] = [];
  const spent: bigint[] = [];
  const insertArtifacts = await loadDevArtifacts('insert', repoRoot);

  async function insert() {
    const pool = await readPool(ctx);
    const plan = planInsert({ poolId: ctx.deployment.poolId, pool,
      config: (await readConfig(ctx)).datum, deposits: await readDeposits(ctx) });
    assert.ok(plan);
    const witness = insertWitness({ tree, slots: plan.slots });
    const proof = await prove(insertArtifacts, witness.input);
    await run(await buildInsert(ctx, { payer: payer(keys.crank), pool, plan,
      proof: proof.cardano, newRoot: witness.newRoot }), [keys.crank]);
    tree = witness.tree;
    return plan;
  }

  await t.test('IDX-01: two pending deposits retain their public fields', async () => {
    for (const i of [0, 1]) {
      await run(await buildDeposit(ctx, { payer: payer(users[i]!), amount: BigInt(i + 1) * 10_000_000n,
        precommitment: precommitment(secrets[i]!.nullifier, secrets[i]!.secret),
        refundKeyHash: hex(keyHash(users[i]!)) }), [users[i]!]);
    }
    assert.equal(await indexer.sync(), 0);
    const pending = await indexer.getDeposits();
    assert.equal(pending.length, 2);
    for (const i of [0, 1]) {
      const deposit = pending.find(d => d.refundKeyHash === hex(keyHash(users[i]!)))!;
      assert.equal(deposit.status, 'pending');
      assert.equal(deposit.gross, BigInt(i + 1) * 10_000_000n);
      assert.equal(deposit.precommitment, precommitment(secrets[i]!.nullifier, secrets[i]!.secret));
      assert.equal(deposit.value, null);
      assert.equal(deposit.label, null);
      assert.equal(deposit.leafIndex, null);
    }
    const tip = await chain.getTip();
    assert.equal((await indexer.getDeposits(tip.slot)).length, 2);
    assert.deepEqual(await indexer.getDeposits(tip.slot + 1), []);
  });

  await t.test('IDX-02: Insert preserves ledger order, credits, labels, and the root', async () => {
    const plan = await insert();
    deposits = plan.deposits;
    notes = deposits.map((d, index) => {
      const user = users.findIndex(seed => hex(keyHash(seed)) === d.datum.refund);
      return { ...secrets[user]!, value: plan.credited[index]!.value, label: plan.credited[index]!.label };
    });
    assert.equal(await indexer.sync(), 1);
    const views = await indexer.getDeposits();
    const expected = deposits.map((d, i) => {
      const label = labelFor({ poolId: Buffer.from(ctx.deployment.poolId, 'hex'),
        txId: Buffer.from(d.utxo.ref.txId, 'hex'), outputIndex: d.utxo.ref.index,
        refundKeyHash: Buffer.from(d.datum.refund, 'hex') });
      const value = d.utxo.value.lovelace - 300_000n;
      assert.deepEqual(views.find(v => v.txId === d.utxo.ref.txId && v.index === d.utxo.ref.index), {
        txId: d.utxo.ref.txId, index: d.utxo.ref.index, gross: d.utxo.value.lovelace,
        precommitment: d.datum.precommitment, refundKeyHash: d.datum.refund,
        status: 'absorbed', value, label, leafIndex: i,
      });
      return h3(value, label, d.datum.precommitment);
    });
    assert.deepEqual((await indexer.getLeaves(0, 10)).leaves, expected);
    assert.deepEqual((await indexer.getLeaves(1, 1)).leaves, expected.slice(1));
    assert.equal(indexer.tree().root, (await readPool(ctx)).datum.roots[0]);
    const copy = indexer.tree();
    copy.append(999n);
    assert.equal(indexer.tree().size, 2);
    const before = await indexer.getLeaves(0, 10);
    chain.rollback(1);
    await indexer.sync();
    assert.equal(indexer.tree().size, 0);
    assert.ok((await indexer.getDeposits()).every(d => d.status === 'pending'));
    tree = MerkleTree.empty();
    await insert();
    await indexer.sync();
    assert.deepEqual(await indexer.getLeaves(0, 10), before);
  });

  await t.test('IDX-01: Settle records a nullifier and queues the change note', async () => {
    labels = notes.map(note => note.label);
    const aspTree = MerkleTree.fromLeaves(labels);
    await run(await buildAspUpdate(ctx, { payer: payer(keys.asp), root: aspTree.root,
      signers: [hex(keyHash(keys.asp))] }), [keys.asp]);
    const pool = await readPool(ctx);
    const intent: SettleIntent = { poolId: Buffer.from(ctx.deployment.poolId, 'hex'),
      payouts: [{ address: { payment: { kind: 'key', hash: keyHash(users[2]!) }, stake: null },
        amount: 3_000_000n, datumHash: null }], relayer: keyHash(keys.relayer),
      validUntil: BigInt((await chain.getTip()).time + 300_000) };
    const fresh = deriveNoteSecrets(users[0]!, 1);
    const witness = spendWitness({ note: notes[0]!, stateTree: tree, stateIndex: 0,
      aspTree, aspIndex: 0, withdrawn: 4_000_000n, newNullifier: fresh.nullifier,
      newSecret: fresh.secret, context: contextFor(intent) });
    const proof = await prove(await loadDevArtifacts('spend', repoRoot), witness.input);
    const trie = await nullifierInsertion(spent, witness.public.nullifierHash);
    await run(await buildSettle(ctx, { payer: payer(keys.relayer), pool, proof: proof.cardano,
      ...witness.public, withdrawn: witness.public.withdrawnValue,
      intent, nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot }), [keys.relayer]);
    spent.push(witness.public.nullifierHash);
    await indexer.sync();
    assert.deepEqual(indexer.spent(), spent);
    assert.deepEqual((await indexer.getPool()).queue, [commitment(witness.changeNote)]);
    assert.equal((await indexer.getPool()).nullifierRoot, await nullifierRoot(spent));
    const copy = indexer.spent();
    copy.push(1n);
    assert.deepEqual(indexer.spent(), spent);
  });

  await t.test('IDX-02: a note-only Insert appends the queued commitment', async () => {
    const queue = (await indexer.getPool()).queue;
    await insert();
    await indexer.sync();
    assert.equal(indexer.tree().size, 3);
    assert.equal(indexer.tree().leaf(2), queue[0]);
    assert.equal(indexer.tree().root, (await readPool(ctx)).datum.roots[0]);
    assert.deepEqual((await indexer.getPool()).queue, []);
  });

  await t.test('IDX-01, IDX-03: Ragequit records a nullifier and rollback removes it', async () => {
    const before = await indexer.getPool();
    const pool = await readPool(ctx);
    const witness = ragequitWitness({ note: notes[1]!, stateTree: tree, stateIndex: 1 });
    const proof = await prove(await loadDevArtifacts('ragequit', repoRoot), witness.input);
    const trie = await nullifierInsertion(spent, witness.nullifierHash);
    const refund = users.find(seed => hex(keyHash(seed)) === deposits[1]!.datum.refund)!;
    await run(await buildRagequit(ctx, { payer: payer(refund), pool, proof: proof.cardano,
      nullifierHash: witness.nullifierHash, value: notes[1]!.value, stateRoot: tree.root,
      depositRef: deposits[1]!.utxo.ref, refundKeyHash: deposits[1]!.datum.refund,
      nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot, payTo: payer(refund).address }), [refund]);
    await indexer.sync();
    assert.deepEqual(indexer.spent(), [...spent, witness.nullifierHash]);
    chain.rollback(1);
    await indexer.sync();
    assert.deepEqual(await indexer.getPool(), before);
    assert.deepEqual(indexer.spent(), spent);
  });

  await t.test('IDX-01, IDX-03: refund history survives restart and rollback', async () => {
    await run(await buildDeposit(ctx, { payer: payer(users[2]!), amount: 5_000_000n,
      precommitment: precommitment(secrets[2]!.nullifier, secrets[2]!.secret),
      refundKeyHash: hex(keyHash(users[2]!)) }), [users[2]!]);
    await indexer.sync();
    const before = await indexer.getDeposits();
    const [deposit] = await readDeposits(ctx);
    assert.ok(deposit);
    await run(await buildRefund(ctx, { payer: payer(users[2]!), deposit, payTo: payer(users[2]!).address }), [users[2]!]);
    await indexer.sync();
    assert.equal((await indexer.getDeposits()).find(d => d.txId === deposit.utxo.ref.txId)!.status, 'refunded');
    const rebuilt = new Indexer({ ctx, history: chain, aspLeaves: () => labels });
    await rebuilt.sync();
    assert.deepEqual(await rebuilt.getDeposits(), await indexer.getDeposits());
    assert.deepEqual(await rebuilt.getPool(), await indexer.getPool());
    assert.deepEqual(rebuilt.spent(), spent);
    chain.rollback(1);
    await indexer.sync();
    assert.deepEqual(await indexer.getDeposits(), before);
  });

  await t.test('IDX-03: provider failures preserve the last complete snapshot', async () => {
    let fail = false;
    const history: ChainHistory = {
      getTransactionsAt: (address, after) => {
        if (fail) return Promise.reject(new Error('provider unavailable'));
        return chain.getTransactionsAt(address, after);
      },
      getTransactionCbor: id => chain.getTransactionCbor(id),
    };
    const resilient = new Indexer({ ctx, history, aspLeaves: () => labels });
    await resilient.sync();
    const before = await resilient.getPool();
    fail = true;
    await assert.rejects(resilient.sync(), /provider unavailable/);
    assert.deepEqual(await resilient.getPool(), before);
  });

  await t.test('IDX-01 HTTP: the client matches memory at every SPEC path', async () => {
    const server = await serveIndexer(indexer, { port: 0, syncMs: 20 });
    try {
      const client = new IndexerClient(server.url);
      assert.deepEqual(await client.getPool(), await indexer.getPool());
      assert.deepEqual(await client.getLeaves(0, 1001), await indexer.getLeaves(0, 1001));
      assert.deepEqual(await client.getAspLeaves(0, 10), await indexer.getAspLeaves(0, 10));
      assert.deepEqual(await client.getDeposits(), await indexer.getDeposits());
      assert.deepEqual(await client.getNullifiers(0, 10), await indexer.getNullifiers(0, 10));
      const response = await fetch(`${server.url}/v1/leaves?from=0&limit=1`);
      const json = await response.json() as { leaves: unknown[] };
      assert.equal(typeof json.leaves[0], 'string');
      await assert.rejects(client.getLeaves(-1, 1), error => error instanceof ApiError && error.code === 'bad_request');
      chain.mineBlock();
      const expected = (await chain.getTip()).blockHash;
      for (let attempt = 0; attempt < 100 && (await client.getPool()).tip.hash !== expected; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal((await client.getPool()).tip.hash, expected);
    } finally {
      await server.close();
    }
  });
});
