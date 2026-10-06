import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  MerkleTree, NETWORKS, deriveNoteSecrets, insertWitness, precommitment, spendWitness, type Note,
} from '@zbase-cardano/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zbase-cardano/prover';
import {
  buildDeposit, buildInsert, enterpriseAddress, keyHash, planInsert, readAsp, readConfig, readDeposits, readPool,
} from '@zbase-cardano/txlib';
import { startDevnet } from '@zbase-cardano/txlib/testing/devnet';
import { Indexer } from '@zbase-cardano/indexer';
import { AspService } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
after(shutdown);

test('ASP-01, TX-07: automatic approval, denial, removal, and persistence', {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json',
}, async t => {
  const { chain, ctx, keys, run } = await startDevnet();
  chain.advanceSlots(NETWORKS[ctx.deployment.network].zeroSlot);
  const payer = (seed: Uint8Array) => ({ address: enterpriseAddress(seed, ctx.deployment.network) });
  const secrets = keys.users.slice(0, 2).map(seed => deriveNoteSecrets(seed, 0));
  for (const i of [0, 1]) {
    await run(await buildDeposit(ctx, { payer: payer(keys.users[i]!), amount: 10_000_000n,
      precommitment: precommitment(secrets[i]!.nullifier, secrets[i]!.secret),
      refundKeyHash: hex(keyHash(keys.users[i]!)) }), [keys.users[i]!]);
  }
  const pool = await readPool(ctx);
  const plan = planInsert({ poolId: ctx.deployment.poolId, pool,
    config: (await readConfig(ctx)).datum, deposits: await readDeposits(ctx) });
  assert.ok(plan);
  const witness = insertWitness({ tree: MerkleTree.empty(), slots: plan.slots });
  const proof = await prove(await loadDevArtifacts('insert', repoRoot), witness.input);
  await run(await buildInsert(ctx, { payer: payer(keys.crank), pool, plan, proof: proof.cardano,
    newRoot: witness.newRoot }), [keys.crank]);
  let service: AspService;
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: () => service?.leaves() ?? [] });
  await indexer.sync();
  const labels = plan.credited.map(credit => credit.label);
  const options = { ctx, indexer, payerSeed: keys.operator, operatorSeeds: [keys.asp] };
  const build = fileURLToPath(new URL('../build/', import.meta.url));
  mkdirSync(build, { recursive: true });
  const directory = mkdtempSync(join(build, 'asp-test-'));
  const storePath = join(directory, 'labels.json');
  t.after(() => rmSync(directory, { recursive: true }));

  await t.test('ASP-01: absorbed labels produce the confirmed Merkle root once', async () => {
    service = new AspService({ ...options, storePath });
    const result = await service.tick();
    assert.equal(result.approved, 2);
    assert.ok(result.txId);
    assert.deepEqual(service.leaves(), labels);
    // Confirmation is explicit. A second tick must not double-spend the old ASP UTXO.
    assert.notEqual((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves(labels).root);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
    chain.mineBlock();
    assert.equal((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves(labels).root);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
    await indexer.sync();
    assert.deepEqual((await indexer.getAspLeaves(0, 10)).leaves, labels);
  });

  await t.test('ASP-01: a denied deposit is omitted', async () => {
    const denied = new AspService({ ...options, deny: deposit => deposit.label === labels[1] });
    const result = await denied.tick();
    assert.equal(result.approved, 1);
    assert.ok(result.txId);
    assert.deepEqual(denied.leaves(), [labels[0]]);
    chain.mineBlock();
    assert.equal((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves([labels[0]!]).root);
    const restore = await service.tick();
    assert.ok(restore.txId);
    chain.mineBlock();
  });

  await t.test('ASP-01: removal stays removed and prevents building a spend witness', async () => {
    const user = keys.users.findIndex(seed => hex(keyHash(seed)) === plan.deposits[0]!.datum.refund);
    const note: Note = { ...secrets[user]!, ...plan.credited[0]! };
    const fresh = deriveNoteSecrets(keys.users[user]!, 1);
    const args = { note, stateTree: witness.tree, stateIndex: 0, aspIndex: 0, withdrawn: 1_000_000n,
      newNullifier: fresh.nullifier, newSecret: fresh.secret, context: 0n };
    assert.doesNotThrow(() => spendWitness({ ...args, aspTree: MerkleTree.fromLeaves(service.leaves()) }));
    service.remove(labels[0]!);
    assert.deepEqual(service.leaves(), [0n, labels[1]]);
    const result = await service.tick();
    assert.equal(result.approved, 0);
    assert.ok(result.txId);
    chain.mineBlock();
    assert.equal((await readAsp(ctx)).datum.root, MerkleTree.fromLeaves([0n, labels[1]!]).root);
    assert.throws(() => spendWitness({ ...args, aspTree: MerkleTree.fromLeaves(service.leaves()) }), /aspTree leaf/);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
  });

  await t.test('ASP-01: restart preserves order and removal tombstones', async () => {
    service = new AspService({ ...options, storePath });
    assert.deepEqual(service.leaves(), [0n, labels[1]]);
    assert.deepEqual(await service.tick(), { approved: 0, txId: null });
    const copy = service.leaves();
    copy.push(42n);
    assert.equal(service.leaves().length, 2);
  });

  await t.test('ASP-01: missing operator signatures cannot post a root', async () => {
    const unauthorized = new AspService({ ...options, operatorSeeds: [] });
    const before = await readAsp(ctx);
    await assert.rejects(unauthorized.tick(), /threshold|operator|sign/i);
    assert.deepEqual(await readAsp(ctx), before);
  });
});
