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
  readConfig, readDeposits, readPool, type ChainHistory, type DepositUtxo, type Provider,
} from '@zbase-cardano/txlib';
import { startDevnet } from '@zbase-cardano/txlib/testing/devnet';
import { Indexer, serveIndexer } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
after(shutdown);

async function waitUntil(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Polling did not reach the expected state');
}

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
  chain.mineBlock();
  await assert.rejects(indexer.sync(), /tip changed/i);
  assert.deepEqual(await indexer.getPool(), before);
  changeTip = false;
  await indexer.sync();
  assert.equal((await indexer.getPool()).tip.hash, (await chain.getTip()).blockHash);
});

test('IDX-03: a failed cold sync keeps fetched transactions for the next attempt', async () => {
  const { chain, ctx, keys, run } = await startDevnet();
  const user = keys.users[0]!;
  const depositId = await run(await buildDeposit(ctx, {
    payer: { address: enterpriseAddress(user, ctx.deployment.network) }, amount: 5_000_000n,
    precommitment: 1n, refundKeyHash: hex(keyHash(user)),
  }), [user]);
  const calls = new Map<string, number>();
  const history: ChainHistory = {
    getTransactionsAt: (address, after) => chain.getTransactionsAt(address, after),
    getTransactionCbor: id => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return chain.getTransactionCbor(id);
    },
  };
  let changeTip = true;
  const indexer = new Indexer({ ctx, history, aspLeaves: async () => {
    if (changeTip) chain.mineBlock();
    return [];
  } });
  await assert.rejects(indexer.sync(), /tip changed/i);
  await assert.rejects(indexer.getPool(), /has not synced/);
  assert.deepEqual(calls, new Map([[depositId, 1], [ctx.deployment.initTx, 1]]));
  changeTip = false;
  assert.equal(await indexer.sync(), 1);
  assert.equal((await indexer.getPool()).tip.hash, (await chain.getTip()).blockHash);
  assert.equal((await indexer.getDeposits())[0]?.txId, depositId);
  for (const [id, count] of calls) assert.equal(count, 1, `Transaction ${id} was fetched more than once`);
});

test('IDX-03: a rollback resets the snapshot but keeps fetched transactions', async () => {
  const { chain, ctx, keys, run } = await startDevnet();
  const user = keys.users[0]!;
  const depositId = await run(await buildDeposit(ctx, {
    payer: { address: enterpriseAddress(user, ctx.deployment.network) }, amount: 5_000_000n,
    precommitment: 1n, refundKeyHash: hex(keyHash(user)),
  }), [user]);
  const calls = new Map<string, number>();
  const history: ChainHistory = {
    getTransactionsAt: (address, after) => chain.getTransactionsAt(address, after),
    getTransactionCbor: id => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return chain.getTransactionCbor(id);
    },
  };
  const indexer = new Indexer({ ctx, history });
  assert.equal(await indexer.sync(), 1);
  assert.equal((await indexer.getDeposits())[0]?.txId, depositId);
  assert.deepEqual(calls, new Map([[depositId, 1], [ctx.deployment.initTx, 1]]));
  chain.rollback(1);
  assert.equal(await indexer.sync(), 1);
  assert.deepEqual(await indexer.getDeposits(), []);
  assert.equal((await indexer.getPool()).tip.hash, (await chain.getTip()).blockHash);
  for (const [id, count] of calls) assert.equal(count, 1, `Transaction ${id} was fetched more than once`);
});

test('IDX-01: ASP refresh passes the confirmed root and caches leaf checks', async t => {
  const { chain, ctx, keys, run } = await startDevnet();
  const roots: bigint[] = [];
  const labels = [7n];
  const approvedRoot = MerkleTree.fromLeaves(labels).root;
  let leaves: bigint[] = [];
  const hashes = t.mock.method(MerkleTree, 'fromLeaves');
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: async root => {
    roots.push(root);
    return [...leaves];
  } });
  await indexer.sync();
  const emptyRoot = (await indexer.getPool()).aspRoot;
  assert.deepEqual(roots, [emptyRoot]);
  assert.equal(hashes.mock.callCount(), 1);
  await indexer.getAspLeaves(0, 10);
  await indexer.getAspLeaves(0, 10);
  await indexer.sync();
  chain.mineBlock();
  await indexer.sync();
  assert.equal(hashes.mock.callCount(), 1);
  leaves = labels;
  await indexer.sync();
  assert.equal(hashes.mock.callCount(), 2);
  await assert.rejects(indexer.getAspLeaves(0, 10), error => error instanceof ApiError && error.code === 'stale_asp_root');
  await indexer.sync();
  assert.equal(hashes.mock.callCount(), 2);
  await run(await buildAspUpdate(ctx, { payer: { address: enterpriseAddress(keys.asp, ctx.deployment.network) },
    root: approvedRoot, signers: [hex(keyHash(keys.asp))] }), [keys.asp]);
  const before = hashes.mock.callCount();
  await indexer.sync();
  assert.equal(roots.at(-1), approvedRoot);
  assert.deepEqual((await indexer.getAspLeaves(0, 10)).leaves, labels);
  assert.equal(hashes.mock.callCount(), before + 1);
});

test('IDX-01: an unchanged tip reads only getTip and refreshes ASP leaves', async () => {
  const { chain, ctx } = await startDevnet();
  const calls: string[] = [];
  const provider: Provider = {
    getTip: () => { calls.push('getTip'); return chain.getTip(); },
    getUtxosAt: address => { calls.push('getUtxosAt'); return chain.getUtxosAt(address); },
    getUtxos: refs => { calls.push('getUtxos'); return chain.getUtxos(refs); },
    getProtocolParameters: () => { calls.push('getProtocolParameters'); return chain.getProtocolParameters(); },
    evaluate: cbor => { calls.push('evaluate'); return chain.evaluate(cbor); },
    submit: cbor => { calls.push('submit'); return chain.submit(cbor); },
  };
  const history: ChainHistory = {
    getTransactionsAt: (address, after) => { calls.push('getTransactionsAt'); return chain.getTransactionsAt(address, after); },
    getTransactionCbor: id => { calls.push('getTransactionCbor'); return chain.getTransactionCbor(id); },
  };
  const leaves: bigint[] = [1n];
  const roots: bigint[] = [];
  const indexer = new Indexer({ ctx: { ...ctx, provider }, history, aspLeaves: root => { roots.push(root); return leaves; } });
  await indexer.sync();
  await assert.rejects(indexer.getAspLeaves(0, 10), error => error instanceof ApiError && error.code === 'stale_asp_root');
  const pool = await indexer.getPool();
  calls.length = 0;
  leaves.length = 0;
  assert.equal(await indexer.sync(), 0);
  assert.deepEqual(calls, ['getTip']);
  assert.deepEqual(roots, [pool.aspRoot, pool.aspRoot]);
  assert.deepEqual(await indexer.getAspLeaves(0, 10), { from: 0, leaves: [], root: pool.aspRoot });
  assert.deepEqual(await indexer.getPool(), pool);
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

test('IDX-03 HTTP: a failed poll serves the last snapshot and reports the error once', async t => {
  const { chain, ctx } = await startDevnet();
  const getTip = chain.getTip.bind(chain);
  const failure = new Error('provider unavailable');
  let failOnce = false;
  let failures = 0;
  t.mock.method(chain, 'getTip', async () => {
    if (failOnce) { failOnce = false; failures += 1; throw failure; }
    return getTip();
  });
  const indexer = new Indexer({ ctx, history: chain });
  const errors: unknown[] = [];
  const server = await serveIndexer(indexer, { port: 0, syncMs: 500, onError: error => { errors.push(error); } });
  t.after(() => server.close());
  const client = new IndexerClient(server.url);
  const before = await client.getPool();
  failOnce = true;
  await waitUntil(() => failures === 1);
  assert.deepEqual(await client.getPool(), before);
  assert.deepEqual(await client.getLeaves(0, 10), await indexer.getLeaves(0, 10));
  assert.deepEqual(await client.getAspLeaves(0, 10), await indexer.getAspLeaves(0, 10));
  assert.deepEqual(await client.getDeposits(), await indexer.getDeposits());
  assert.deepEqual(await client.getNullifiers(0, 10), await indexer.getNullifiers(0, 10));
  assert.deepEqual(errors, [failure]);
});

test('IDX-03 HTTP: expired snapshots answer 503 and recover after a successful poll', async t => {
  const { chain, ctx } = await startDevnet();
  const getTip = chain.getTip.bind(chain);
  let failing = false;
  let failures = 0;
  const errors: unknown[] = [];
  t.mock.method(chain, 'getTip', async () => {
    if (failing) { failures += 1; throw new Error('provider unavailable'); }
    return getTip();
  });
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const indexer = new Indexer({ ctx, history: chain });
  const server = await serveIndexer(indexer, { port: 0, syncMs: 10, maxStaleMs: 50,
    onError: error => { errors.push(error); } });
  t.after(() => server.close());
  const client = new IndexerClient(server.url);
  const before = await client.getPool();
  failing = true;
  await waitUntil(() => failures >= 2);
  now += 50;
  assert.deepEqual(await client.getPool(), before);
  now += 1;
  for (const path of ['/v1/pool', '/v1/leaves?from=0&limit=1', '/v1/asp/leaves?from=0&limit=1',
    '/v1/deposits', '/v1/nullifiers?from=0&limit=1']) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'internal', message: 'Indexer snapshot is too old' } });
  }
  assert.equal(errors.length, failures);
  failing = false;
  await waitUntil(async () => (await fetch(`${server.url}/v1/pool`)).status === 200);
  assert.deepEqual(await client.getPool(), before);
});

test('IDX-03 HTTP: caller-driven sync owns readiness and freshness with no server polling', async t => {
  const { chain, ctx } = await startDevnet();
  const tip = t.mock.method(chain, 'getTip');
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const indexer = new Indexer({ ctx, history: chain });
  assert.equal(indexer.syncedAt, undefined);
  const server = await serveIndexer(indexer, { port: 0, syncMs: 0, maxStaleMs: 50 });
  t.after(() => server.close());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(tip.mock.callCount(), 0);
  assert.equal((await fetch(`${server.url}/v1/pool`)).status, 503);
  await indexer.sync();
  assert.equal(indexer.syncedAt, now);
  const client = new IndexerClient(server.url);
  const before = await client.getPool();
  now += 50;
  assert.deepEqual(await client.getPool(), before);
  now += 1;
  assert.equal((await fetch(`${server.url}/v1/pool`)).status, 503);
  // An unchanged tip still confirms the snapshot's freshness.
  assert.equal(await indexer.sync(), 0);
  assert.equal(indexer.syncedAt, now);
  assert.deepEqual(await client.getPool(), before);
  const syncedAt = indexer.syncedAt;
  tip.mock.mockImplementation(async () => { throw new Error('provider unavailable'); });
  now += 51;
  await assert.rejects(indexer.sync(), /provider unavailable/);
  assert.equal(indexer.syncedAt, syncedAt);
  assert.equal((await fetch(`${server.url}/v1/pool`)).status, 503);
});

test('IDX-03 HTTP: startup retries two failed syncs before serving', async t => {
  const { chain, ctx } = await startDevnet();
  const getTip = chain.getTip.bind(chain);
  const failures = [new Error('startup one'), new Error('startup two')];
  let calls = 0;
  const errors: unknown[] = [];
  t.mock.method(chain, 'getTip', async () => {
    calls += 1;
    if (calls <= failures.length) throw failures[calls - 1];
    return getTip();
  });
  const indexer = new Indexer({ ctx, history: chain });
  const server = await serveIndexer(indexer, { port: 0, syncMs: 10, onError: error => { errors.push(error); } });
  t.after(() => server.close());
  assert.deepEqual(errors, failures);
  assert.deepEqual(await new IndexerClient(server.url).getPool(), await indexer.getPool());
});

test('IDX-03 HTTP: startup stops after five failed syncs and throws the last error', async t => {
  const { chain, ctx } = await startDevnet();
  const failures = Array.from({ length: 5 }, (_, index) => new Error(`startup ${index}`));
  let calls = 0;
  const errors: unknown[] = [];
  t.mock.method(chain, 'getTip', async () => { throw failures[calls++]; });
  await assert.rejects(serveIndexer(new Indexer({ ctx, history: chain }), { port: 0, syncMs: 10,
    onError: error => { errors.push(error); } }), error => error === failures[4]);
  assert.equal(calls, 5);
  assert.deepEqual(errors, failures);
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
    chain.mineBlock();
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
