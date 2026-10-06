import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ApiError, RelayerClient, relayerRoutes, serveJson,
  type ErrorCode, type IndexerApi, type PayoutRequest, type SettleRequest,
} from '@zbase-cardano/api';
import {
  MerkleTree, NETWORKS, R, addressFromBech32, contextFor, deriveNoteSecrets, insertWitness,
  precommitment, spendWitness, type Note,
} from '@zbase-cardano/crypto';
import { devKeysPresent, loadDevArtifacts, loadDevVkey, prove, shutdown } from '@zbase-cardano/prover';
import {
  buildAspUpdate, buildDeposit, buildInsert, complete, decodePoolRedeemer, decodeTx,
  encodeConfigDatum, encodeVoid, enterpriseAddress, keyHash, newTxBuilder, planInsert,
  readAsp, readConfig, readDeposits, readPool, signTx, utxoToMesh,
  type ChainContext,
} from '@zbase-cardano/txlib';
import { startDevnet } from '@zbase-cardano/txlib/testing/devnet';
import { Relayer } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const rejects = (promise: Promise<unknown>, code: ErrorCode) =>
  assert.rejects(promise, error => error instanceof ApiError && error.code === code);
after(shutdown);

// The indexer service was absent when this lane began. Keep the test on its public interface.
function fakeIndexer(ctx: ChainContext, leaves: bigint[], spent: bigint[]): IndexerApi {
  return {
    async getPool() {
      const [pool, config, asp, tip] = await Promise.all([readPool(ctx), readConfig(ctx), readAsp(ctx), ctx.provider.getTip()]);
      const { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee } = config.datum;
      return { poolId: ctx.deployment.poolId, asset: 'lovelace', ...pool.datum, aspRoot: asp.datum.root,
        config: { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee },
        tip: { slot: tip.slot, hash: tip.blockHash } };
    },
    async getLeaves(from, limit) {
      return { from, leaves: leaves.slice(from, from + limit), size: leaves.length, root: MerkleTree.fromLeaves(leaves).root };
    },
    async getAspLeaves(from) { return { from, leaves: [], root: (await readAsp(ctx)).datum.root }; },
    async getNullifiers(from, limit) { return { from, nullifiers: spent.slice(from, from + Math.min(limit, 1)) }; },
    async getDeposits() {
      return (await readDeposits(ctx)).map(({ utxo, datum }) => ({ ...utxo.ref, gross: utxo.value.lovelace,
        precommitment: datum.precommitment, refundKeyHash: datum.refund, status: 'pending' as const,
        value: null, label: null, leafIndex: null }));
    },
  };
}

test('REL-01: quotes include both fees and validate payouts without proving keys', { timeout: 120_000 }, async () => {
  const { ctx, keys } = await startDevnet();
  const indexer = fakeIndexer(ctx, [], []);
  const original = indexer.getPool;
  indexer.getPool = async () => {
    const view = await original();
    return { ...view, config: { ...view.config, settleFeeBps: 100 } };
  };
  const relayer = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: await loadDevVkey('spend', repoRoot), now: () => 123_000 });
  const address = enterpriseAddress(keys.users[0]!, ctx.deployment.network);
  const payouts = [{ address, amount: 2_000_000n, datumHash: null }, { address, amount: 3_000_000n, datumHash: null }];
  const quote = await relayer.quote(payouts);
  assert.equal(quote.protocolFee, 50_000n);
  assert.equal(quote.relayerFee, 1_000_000n);
  assert.equal(quote.withdrawn, 6_050_000n);
  assert.equal(quote.validUntil, 243_000);
  assert.equal(quote.poolId, ctx.deployment.poolId);
  assert.equal(quote.relayerKeyHash, hex(keyHash(keys.relayer)));
  for (const bad of [[], Array(5).fill(payouts[0]), [{ ...payouts[0]!, address: 'bad' }],
    [{ ...payouts[0]!, address: enterpriseAddress(keys.users[0]!, 'mainnet') }],
    [{ ...payouts[0]!, amount: 999_999n }]]) {
    await rejects(relayer.quote(bad), 'bad_request');
  }
  await rejects(relayer.getSettle('unknown'), 'not_found');
});

test('REL-02, REL-03, REL-04, REL-05, HTTP: real proof relayer story', {
  timeout: 1_200_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { chain, ctx, keys, run } = await startDevnet({ users: 4 });
  const network = ctx.deployment.network;
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const payer = (seed: Uint8Array) => ({ address: enterpriseAddress(seed, network) });
  const config = await readConfig(ctx);
  const configScript = ctx.deployment.scripts.config;
  const configRef = ctx.deployment.refScripts.config;
  const builder = await newTxBuilder({ provider: chain, network });
  builder.spendingPlutusScriptV3()
    .txIn(config.utxo.ref.txId, config.utxo.ref.index, utxoToMesh(config.utxo).output.amount, config.utxo.address, 0)
    .spendingTxInReference(configRef.txId, configRef.index, String(configScript.size), configScript.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodeVoid(), 'CBOR')
    // The larger fee integer increases datum bytes, so fund the continuing output's minimum ADA.
    .txOut(config.utxo.address, utxoToMesh({ ...config.utxo,
      value: { ...config.utxo.value, lovelace: config.utxo.value.lovelace + 1_000_000n } }).output.amount)
    .txOutInlineDatumValue(encodeConfigDatum({ ...config.datum, settleFeeBps: 100 }), 'CBOR')
    .requiredSignerHash(hex(keyHash(keys.admin[0]!)));
  await run(await complete({ provider: chain, network }, builder, { payer: payer(keys.admin[0]!),
    extraUtxos: [config.utxo, ...await chain.getUtxos([configRef])] }), [keys.admin[0]!]);

  const artifacts = { insert: await loadDevArtifacts('insert', repoRoot), spend: await loadDevArtifacts('spend', repoRoot) };
  const secrets = keys.users.map(key => deriveNoteSecrets(key, 0));
  for (const [i, key] of keys.users.entries()) {
    await run(await buildDeposit(ctx, { payer: payer(key), amount: 20_000_000n,
      precommitment: precommitment(secrets[i]!.nullifier, secrets[i]!.secret), refundKeyHash: hex(keyHash(key)) }), [key]);
  }
  const pool = await readPool(ctx);
  const plan = planInsert({ poolId: ctx.deployment.poolId, pool, config: (await readConfig(ctx)).datum, deposits: await readDeposits(ctx) });
  assert.ok(plan);
  const insertion = insertWitness({ tree: MerkleTree.empty(), slots: plan.slots });
  await run(await buildInsert(ctx, { payer: payer(keys.crank), pool, plan,
    proof: (await prove(artifacts.insert, insertion.input)).cardano, newRoot: insertion.newRoot }), [keys.crank]);
  let tree = insertion.tree;
  const leaves = [...insertion.leaves];
  const spent: bigint[] = [];
  const notes: Note[] = plan.deposits.map((deposit, index) => {
    const user = keys.users.findIndex(key => hex(keyHash(key)) === deposit.datum.refund);
    return { ...secrets[user]!, value: plan.credited[index]!.value, label: plan.credited[index]!.label };
  });
  const aspTree = MerkleTree.fromLeaves(notes.map(note => note.label));
  await run(await buildAspUpdate(ctx, { payer: payer(keys.asp), root: aspTree.root, signers: [hex(keyHash(keys.asp))] }), [keys.asp]);
  const indexer = fakeIndexer(ctx, leaves, spent);
  let now = (await chain.getTip()).time;
  const relayer = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
    quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
  const server = await serveJson(relayerRoutes(relayer), 0);
  t.after(() => server.close());
  const client = new RelayerClient(server.url);
  let submissions = 0;
  let pending: bigint[] = [];
  const submit = chain.submit.bind(chain);
  chain.submit = async cbor => {
    submissions++;
    const txId = await submit(cbor);
    for (const redeemer of decodeTx(cbor).redeemers) {
      const value = decodePoolRedeemer(redeemer.dataCbor);
      if (value.kind === 'Settle') pending.push(value.nullifierHash);
    }
    return txId;
  };
  const mine = () => { chain.mineBlock(); spent.push(...pending); pending = []; };
  const requests: SettleRequest[] = [];
  const sellers = Array.from({ length: 4 }, (_, i) => new Uint8Array(32).fill(101 + i));
  for (let i = 0; i < notes.length; i++) {
    const payouts: PayoutRequest[] = [{ address: payer(sellers[i]!).address, amount: 2_000_000n, datumHash: null }];
    const quote = await (i === 0 ? client : relayer).quote(payouts);
    assert.equal(quote.protocolFee, 20_000n);
    assert.equal(quote.withdrawn, 3_020_000n);
    const intent = { poolId: quote.poolId, payouts, relayer: quote.relayerKeyHash, validUntil: quote.validUntil };
    const context = contextFor({ poolId: Buffer.from(intent.poolId, 'hex'), relayer: Buffer.from(intent.relayer, 'hex'),
      validUntil: BigInt(intent.validUntil), payouts: payouts.map(p => ({ ...p, address: addressFromBech32(p.address, network), datumHash: null })) });
    const fresh = deriveNoteSecrets(sellers[i]!, 1);
    const witness = spendWitness({ note: notes[i]!, stateTree: tree, stateIndex: i, aspTree, aspIndex: i,
      withdrawn: quote.withdrawn, newNullifier: fresh.nullifier, newSecret: fresh.secret, context });
    const proof = await prove(artifacts.spend, witness.input);
    requests.push({ quoteId: quote.quoteId, intent, proof: { a: hex(proof.cardano.a), b: hex(proof.cardano.b), c: hex(proof.cardano.c) },
      publicInputs: { newCommitment: witness.public.newCommitment, nullifierHash: witness.public.nullifierHash,
        withdrawn: quote.withdrawn, stateRoot: tree.root, aspRoot: aspTree.root, context } });
  }
  const first = requests[0]!;
  await t.test('REL-03: invalid proofs and mismatched intents never reach submission', async () => {
    const before = submissions;
    await rejects(relayer.settle({ ...first, proof: { ...first.proof, a: first.proof.c } }), 'invalid_proof');
    await rejects(relayer.settle({ ...first, proof: { ...first.proof, a: '00'.repeat(48) } }), 'invalid_proof');
    for (const change of [
      { ...first.intent, payouts: [{ ...first.intent.payouts[0]!, amount: 2_000_001n }] },
      { ...first.intent, relayer: hex(keyHash(keys.crank)) },
      { ...first.intent, poolId: 'ab'.repeat(28) },
      { ...first.intent, validUntil: first.intent.validUntil + 1 },
    ]) await rejects(relayer.settle({ ...first, intent: change }), 'intent_mismatch');
    await rejects(relayer.settle({ ...first, publicInputs: { ...first.publicInputs, withdrawn: first.publicInputs.withdrawn + 1n } }), 'intent_mismatch');
    await rejects(relayer.settle({ ...first, publicInputs: { ...first.publicInputs, context: first.publicInputs.context + 1n } }), 'intent_mismatch');
    await rejects(relayer.settle({ ...first, publicInputs: { ...first.publicInputs, nullifierHash: first.publicInputs.nullifierHash + R } }), 'invalid_proof');
    await rejects(relayer.settle({ ...first, quoteId: 'missing' }), 'not_found');
    assert.equal(submissions, before);
  });
  await t.test('REL-04: stale roots and a full queue report their own errors', async () => {
    const before = submissions;
    await rejects(relayer.settle({ ...first, publicInputs: { ...first.publicInputs, stateRoot: 1n } }), 'stale_root');
    const original = indexer.getPool;
    indexer.getPool = async () => ({ ...await original(), aspRoot: 1n });
    await rejects(relayer.settle(first), 'stale_asp_root');
    indexer.getPool = async () => ({ ...await original(), queue: Array<bigint>(8).fill(1n) });
    await rejects(relayer.settle(first), 'queue_full');
    indexer.getPool = original;
    assert.equal(submissions, before);
  });
  await t.test('REL-03: quotes expire at their deadline', async () => {
    const saved = now;
    now = first.intent.validUntil;
    await rejects(relayer.settle(first), 'quote_expired');
    now = saved;
  });
  await t.test('REL-02, HTTP: a valid settle is submitted, then confirmed with the exact payout', async () => {
    assert.deepEqual(await client.getPool(), await relayer.getPool());
    const result = await client.settle(first);
    assert.equal(result.status, 'submitted');
    assert.equal((await client.getSettle(result.id)).status, 'submitted');
    assert.deepEqual(await chain.getUtxosAt(payer(sellers[0]!).address), []);
    mine();
    const confirmed = await client.getSettle(result.id);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.confirmations, 1);
    assert.equal(confirmed.txHash, result.txHash);
    assert.equal((await chain.getUtxosAt(payer(sellers[0]!).address)).reduce((sum, u) => sum + u.value.lovelace, 0n), 2_000_000n);
    assert.equal((await readPool(ctx)).datum.feesAccrued, 20_000n);
    await rejects(client.settle(first), 'nullifier_spent');
  });
  await t.test('REL-02: simultaneous settles wait for confirmation and submit one at a time', async () => {
    const before = submissions;
    const a = relayer.settle(requests[1]!);
    const b = relayer.settle(requests[2]!);
    const firstResult = await a;
    assert.equal(submissions, before + 1);
    assert.equal(firstResult.status, 'submitted');
    mine();
    const secondResult = await b;
    assert.equal(secondResult.status, 'submitted');
    assert.equal(submissions, before + 2);
    mine();
    for (const result of [firstResult, secondResult]) assert.equal((await relayer.getSettle(result.id)).status, 'confirmed');
    for (const seller of sellers.slice(1, 3)) {
      assert.equal((await chain.getUtxosAt(payer(seller).address)).reduce((sum, u) => sum + u.value.lovelace, 0n), 2_000_000n);
    }
  });
  await t.test('REL-05: an unchanged pool fails immediately and exposes a safe failed status', async () => {
    const original = chain.submit;
    let attempts = 0;
    chain.submit = async () => { attempts++; throw new Error('private provider diagnostic'); };
    try {
      await rejects(relayer.settle(requests[3]!), 'internal');
      assert.equal(attempts, 1);
      const failed = await relayer.getSettle(requests[3]!.quoteId);
      assert.equal(failed.status, 'failed');
      assert.ok(!failed.error?.includes('private provider diagnostic'));
    } finally { chain.submit = original; }
  });
  await t.test('REL-05: two competing pool spends trigger two rebuilds and preserve the spend proof', async () => {
    const original = chain.submit;
    let races = 0;
    chain.submit = async cbor => {
      if (races < 2) {
        races++;
        const current = await readPool(ctx);
        const plan = planInsert({ poolId: ctx.deployment.poolId, pool: current, config: (await readConfig(ctx)).datum, deposits: [] });
        assert.ok(plan);
        plan.flush = 1;
        plan.slots = plan.slots.slice(0, 1);
        const witness = insertWitness({ tree, slots: plan.slots });
        const proof = await prove(artifacts.insert, witness.input);
        const tx = await buildInsert(ctx, { payer: payer(keys.crank), pool: current, plan, proof: proof.cardano, newRoot: witness.newRoot });
        await submit(signTx(tx.cbor, [keys.crank]));
        mine();
        tree = witness.tree;
        leaves.push(...witness.leaves);
        throw new Error('Pool input was spent by the crank');
      }
      return original(cbor);
    };
    try {
      const result = await relayer.settle(requests[3]!);
      assert.equal(races, 2);
      assert.equal(result.status, 'submitted');
      mine();
      assert.equal((await relayer.getSettle(result.id)).status, 'confirmed');
      assert.equal((await readPool(ctx)).datum.queue.length, 2);
    } finally { chain.submit = original; }
  });
});
