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
  readAsp, readConfig, readDeposits, readPool, signTx, timeToSlot, utxoToMesh,
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
  assert.equal(quote.validUntil, 423_000);
  assert.equal(quote.poolId, ctx.deployment.poolId);
  assert.equal(quote.relayerKeyHash, hex(keyHash(keys.relayer)));
  for (const bad of [[], Array(5).fill(payouts[0]), [{ ...payouts[0]!, address: 'bad' }],
    [{ ...payouts[0]!, address: enterpriseAddress(keys.users[0]!, 'mainnet') }],
    [{ ...payouts[0]!, amount: 999_999n }]]) {
    await rejects(relayer.quote(bad), 'bad_request');
  }
  await rejects(relayer.getSettle('unknown'), 'not_found');
});

test('REL-01: quote limits include concurrent requests and expired quotes release capacity', { timeout: 120_000 }, async () => {
  const { ctx, keys } = await startDevnet();
  const indexer = fakeIndexer(ctx, [], []);
  let now = 123_000;
  const relayer = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: await loadDevVkey('spend', repoRoot),
    maxQuotes: 2, quoteTtlMs: 1000, now: () => now });
  const payouts = [{ address: enterpriseAddress(keys.users[0]!, ctx.deployment.network), amount: 2_000_000n, datumHash: null }];
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => relayer.quote(payouts)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  const busy = results.find(result => result.status === 'rejected');
  assert.ok(busy?.status === 'rejected' && busy.reason instanceof ApiError);
  assert.equal(busy.reason.status, 503);
  assert.equal(busy.reason.code, 'internal');
  assert.equal(busy.reason.message, 'Relayer is busy');
  now += 999;
  await assert.rejects(relayer.quote(payouts), { status: 503 });
  now++;
  assert.ok(await relayer.quote(payouts));
  assert.ok(await relayer.quote(payouts));
  await assert.rejects(relayer.quote(payouts), { status: 503 });
  const old = results.find(result => result.status === 'fulfilled');
  assert.ok(old?.status === 'fulfilled');
  await rejects(relayer.settle({ quoteId: old.value.quoteId } as SettleRequest), 'not_found');
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
  const logs: { message: string; error: unknown }[] = [];
  const relayer = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
    quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now, log: (message, error) => logs.push({ message, error }) });
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
  const freshRequest = async (request = first, owner = relayer) => {
    const quote = await owner.quote(request.intent.payouts);
    assert.equal(quote.validUntil, request.intent.validUntil, 'the existing proof binds the same deadline');
    return { ...request, quoteId: quote.quoteId };
  };
  await t.test('REL-03: invalid proofs and mismatched intents never reach submission', async () => {
    const before = submissions;
    await rejects(relayer.settle({ ...await freshRequest(), proof: { ...first.proof, a: first.proof.c } }), 'invalid_proof');
    await rejects(relayer.settle({ ...await freshRequest(), proof: { ...first.proof, a: '00'.repeat(48) } }), 'invalid_proof');
    for (const change of [
      { ...first.intent, payouts: [{ ...first.intent.payouts[0]!, amount: 2_000_001n }] },
      { ...first.intent, relayer: hex(keyHash(keys.crank)) },
      { ...first.intent, poolId: 'ab'.repeat(28) },
      { ...first.intent, validUntil: first.intent.validUntil + 1 },
    ]) await rejects(relayer.settle({ ...first, intent: change }), 'intent_mismatch');
    await rejects(relayer.settle({ ...first, publicInputs: { ...first.publicInputs, withdrawn: first.publicInputs.withdrawn + 1n } }), 'intent_mismatch');
    await rejects(relayer.settle({ ...first, publicInputs: { ...first.publicInputs, context: first.publicInputs.context + 1n } }), 'intent_mismatch');
    await rejects(relayer.settle({ ...await freshRequest(), publicInputs: { ...first.publicInputs, nullifierHash: first.publicInputs.nullifierHash + R } }), 'invalid_proof');
    await rejects(relayer.settle({ ...first, quoteId: 'missing' }), 'not_found');
    assert.equal(submissions, before);
  });
  await t.test('REL-03: invalid proof makes no chain reads and consumes its quote', async () => {
    for (const a of [first.proof.c, '00'.repeat(48)]) {
      const request = { ...await freshRequest(), proof: { ...first.proof, a } };
      let indexerCalls = 0;
      let providerCalls = 0;
      const original = ctx.provider;
      const getPool = indexer.getPool;
      const getNullifiers = indexer.getNullifiers;
      indexer.getPool = async () => { indexerCalls++; return getPool(); };
      indexer.getNullifiers = async (...args) => { indexerCalls++; return getNullifiers(...args); };
      ctx.provider = new Proxy(original, { get(target, property) {
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? (...args: unknown[]) => {
          providerCalls++;
          return Reflect.apply(value, target, args);
        } : value;
      } });
      try {
        await rejects(relayer.settle(request), 'invalid_proof');
        assert.equal(indexerCalls, 0);
        assert.equal(providerCalls, 0);
        await rejects(relayer.settle(request), 'not_found');
        assert.equal(indexerCalls, 0);
        assert.equal(providerCalls, 0);
      } finally {
        ctx.provider = original;
        indexer.getPool = getPool;
        indexer.getNullifiers = getNullifiers;
      }
    }
  });
  await t.test('REL-04: stale roots and a full queue report their own errors', async () => {
    const before = submissions;
    const original = indexer.getPool;
    indexer.getPool = async () => ({ ...await original(), roots: [1n] });
    await rejects(relayer.settle(first), 'stale_root');
    indexer.getPool = async () => ({ ...await original(), aspRoot: 1n });
    await rejects(relayer.settle(first), 'stale_asp_root');
    indexer.getPool = async () => ({ ...await original(), queue: Array<bigint>(8).fill(1n) });
    await rejects(relayer.settle(first), 'queue_full');
    indexer.getPool = original;
    assert.equal(submissions, before);
  });
  await t.test('REL-02: failed builds log the underlying error and keep API errors general', async () => {
    const original = chain.getProtocolParameters;
    const underlying = new Error('private build diagnostic');
    chain.getProtocolParameters = async () => { throw underlying; };
    try {
      await assert.rejects(relayer.settle(first), error => error instanceof ApiError
        && error.code === 'internal' && error.message === 'Could not build or submit the settle transaction');
      assert.ok(logs.some(entry => entry.error === underlying));
      assert.equal((await relayer.getSettle(first.quoteId)).error, 'Could not build or submit the settle transaction');
    } finally { chain.getProtocolParameters = original; }
  });
  await t.test('REL-02: a failure before any submit call stays a definite error', async () => {
    const owner = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
    const request = await freshRequest(first, owner);
    const original = chain.getProtocolParameters;
    const before = submissions;
    chain.getProtocolParameters = async () => { throw new Error('private build diagnostic'); };
    try {
      await rejects(owner.settle(request), 'internal');
      assert.equal(submissions, before);
      assert.deepEqual(await owner.getSettle(request.quoteId), {
        id: request.quoteId, status: 'failed', txHash: '00'.repeat(32), confirmations: 0,
        error: 'Could not build or submit the settle transaction',
      });
    } finally { chain.getProtocolParameters = original; }
  });
  for (const [mode, name] of [
    ['landed', 'REL-05: a submit whose reply is lost is uncertain, and its landed transaction confirms'],
    ['late', 'REL-05: a submit whose reply is lost and whose block is late is uncertain'],
    ['rejected', 'REL-05: a submit that failed for good expires as uncertain, then as failed'],
  ] as const) {
    await t.test(name, async () => {
      const owner = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
        quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
      const request = await freshRequest(first, owner);
      const original = chain.submit;
      const getUtxosAt = chain.getUtxosAt;
      const height = chain.blocks().length;
      const spentCount = spent.length;
      let attempts = 0;
      let txHash = '';
      let recovery = false;
      chain.submit = async cbor => {
        attempts++;
        txHash = decodeTx(cbor).txId;
        if (mode !== 'rejected') await original(cbor);
        recovery = true;
        throw new Error('private lost submit reply');
      };
      chain.getUtxosAt = async address => {
        if (mode === 'landed' && recovery && address === ctx.deployment.scripts.pool.address) {
          recovery = false;
          // Sync the public nullifier list only once the local block confirms it.
          mine();
        }
        return getUtxosAt.call(chain, address);
      };
      try {
        if (mode === 'landed') {
          const result = await owner.settle(request);
          assert.deepEqual(result, { id: request.quoteId, status: 'submitted', txHash, confirmations: 0, error: null });
        } else {
          const failure = await owner.settle(request).then(() => undefined, (error: unknown) => error);
          const status = await owner.getSettle(request.quoteId);
          assert.ok(failure instanceof ApiError);
          assert.deepEqual({ code: failure.code, status: status.status }, { code: 'uncertain', status: 'submitted' });
          assert.equal(failure.status, 503);
          assert.ok(!failure.message.includes('private lost submit reply'));
          assert.equal(status.txHash, txHash);
          assert.equal(status.error, null);
          assert.deepEqual(await owner.settle(request), status, 'a replay must keep tracking the same transaction');
          if (mode === 'late') {
            const getPool = indexer.getPool;
            indexer.getPool = async () => { throw new ApiError('internal', 'private indexer diagnostic'); };
            try {
              await assert.rejects(owner.settle(request), error => error instanceof ApiError
                && error.code === 'uncertain' && !error.message.includes('private indexer diagnostic'));
              await rejects(owner.getSettle(request.quoteId), 'uncertain');
            } finally { indexer.getPool = getPool; }
            mine();
          } else chain.mineBlock(timeToSlot(request.intent.validUntil, network) - (await chain.getTip()).slot + 1);
        }
        assert.equal(attempts, 1);
        const status = await owner.getSettle(request.quoteId);
        assert.equal(status.txHash, txHash);
        assert.equal(status.status, mode === 'rejected' ? 'failed' : 'confirmed');
        assert.equal(status.confirmations, mode === 'rejected' ? 0 : 1);
        assert.equal(status.error, mode === 'rejected' ? 'Expired before confirmation' : null);
        if (mode === 'rejected') {
          await rejects(owner.settle(request), 'uncertain');
          assert.equal(attempts, 1, 'a quote that reached submission must not be submitted again');
        }
      } finally {
        chain.submit = original;
        chain.getUtxosAt = getUtxosAt;
        chain.rollback(chain.blocks().length - height);
        spent.length = spentCount;
        pending = [];
      }
    });
  }
  await t.test('REL-02: failed pool reads log the underlying error', async () => {
    const original = chain.getUtxosAt;
    const underlying = new Error('private pool diagnostic');
    chain.getUtxosAt = async () => { throw underlying; };
    try {
      await assert.rejects(relayer.settle(first), error => error instanceof ApiError
        && error.code === 'internal' && error.message === 'Could not read the pool');
      assert.ok(logs.some(entry => entry.error === underlying));
    } finally { chain.getUtxosAt = original; }
  });
  await t.test('REL-03: unexpected verification errors reach the operator log', async () => {
    const underlying = new Error('private verifier diagnostic');
    const vkey = { ...artifacts.spend.vkey, get IC(): never { throw underlying; } };
    const owner = new Relayer({ ctx, indexer, seed: keys.relayer, vkey, quoteTtlMs: 600_000,
      now: () => now, log: (message, error) => logs.push({ message, error }) });
    const request = await freshRequest(first, owner);
    await rejects(owner.settle(request), 'invalid_proof');
    assert.ok(logs.some(entry => entry.error === underlying));
    await rejects(owner.settle(request), 'not_found');
  });
  await t.test('REL-02: the queue cap rejects excess work but admits duplicate requests', async () => {
    const owner = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, maxQueued: 1, now: () => now });
    const a = await freshRequest(first, owner);
    const b = await freshRequest(first, owner);
    const c = await freshRequest(first, owner);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = chain.getUtxosAt;
    let reads = 0;
    chain.getUtxosAt = async () => {
      reads++;
      entered();
      await gate;
      throw new Error('Pool temporarily unavailable');
    };
    const running = owner.settle(a);
    void running.catch(() => undefined);
    await started;
    const repeated = owner.settle(a);
    void repeated.catch(() => undefined);
    const queued = owner.settle(b);
    void queued.catch(() => undefined);
    const duplicate = owner.settle(b);
    void duplicate.catch(() => undefined);
    const before = reads;
    const rejected = Promise.resolve().then(() => owner.settle({ ...c,
      get proof(): never { throw new Error('The full queue must not clone another request'); } }));
    try {
      await assert.rejects(rejected, { code: 'internal', status: 503, message: 'Relayer is busy' });
      assert.equal(reads, before);
      assert.equal(running, repeated);
      assert.equal(queued, duplicate);
    } finally {
      release();
      await Promise.allSettled([running, repeated, queued, duplicate, rejected]);
      chain.getUtxosAt = original;
    }
    await rejects(owner.settle({ quoteId: 'missing' } as SettleRequest), 'not_found');
  });
  await t.test('REL-02: failed submission records expire during settle with a custom retention period', async () => {
    const owner = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, submissionTtlMs: 1000, now: () => now });
    const request = await freshRequest(first, owner);
    const original = chain.getProtocolParameters;
    const saved = now;
    chain.getProtocolParameters = async () => { throw new Error('Build temporarily unavailable'); };
    try {
      await rejects(owner.settle(request), 'internal');
      now = request.intent.validUntil + 999;
      await rejects(owner.settle({ quoteId: 'missing' } as SettleRequest), 'not_found');
      assert.equal((await owner.getSettle(request.quoteId)).status, 'failed');
      now++;
      await rejects(owner.settle({ quoteId: 'missing' } as SettleRequest), 'not_found');
      await rejects(owner.getSettle(request.quoteId), 'not_found');
    } finally { chain.getProtocolParameters = original; now = saved; }
  });
  await t.test('REL-03: quotes expire at their deadline', async () => {
    const saved = now;
    now = first.intent.validUntil;
    await rejects(relayer.settle(first), 'quote_expired');
    now = saved;
  });
  await t.test('REL-02: a dropped settle fails only after the indexer tip passes its deadline', async () => {
    let reads = 0;
    const statusIndexer: IndexerApi = { ...indexer,
      async getPool() { reads++; return indexer.getPool(); },
      async getNullifiers(from, limit) { reads++; return indexer.getNullifiers(from, limit); },
    };
    const owner = new Relayer({ ctx, indexer: statusIndexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, now: () => now });
    const request = await freshRequest(first, owner);
    const original = chain.submit;
    const saved = now;
    const height = chain.blocks().length;
    let attempts = 0;
    chain.submit = async cbor => { attempts++; return decodeTx(cbor).txId; };
    try {
      const result = await owner.settle(request);
      assert.equal((await owner.getSettle(result.id)).status, 'submitted');
      now = request.intent.validUntil + 1;
      assert.equal((await owner.getSettle(result.id)).status, 'submitted', 'wall-clock expiry is not confirmed chain expiry');
      chain.mineBlock(timeToSlot(request.intent.validUntil, network) - (await chain.getTip()).slot);
      assert.equal((await owner.getSettle(result.id)).status, 'submitted');
      chain.mineBlock(1);
      const failed = await owner.getSettle(result.id);
      assert.deepEqual(failed, { ...result, status: 'failed', error: 'Expired before confirmation' });
      const before = reads;
      assert.deepEqual(await owner.getSettle(result.id), failed);
      assert.equal(reads, before, 'the terminal failure is stored');
      await rejects(owner.settle(request), 'uncertain');
      assert.equal(attempts, 1);
    } finally {
      chain.submit = original;
      now = saved;
      chain.rollback(chain.blocks().length - height);
    }
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
    const before = submissions;
    assert.deepEqual(await relayer.settle(first), confirmed);
    assert.equal(submissions, before);
  });
  await t.test('REL-05: one stale nullifier list retries without a pool change', async () => {
    const owner = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
    const request = await freshRequest(requests[1]!, owner);
    const original = indexer.getNullifiers;
    const submit = chain.submit;
    let pages = 0;
    let attempts = 0;
    indexer.getNullifiers = async (from, limit) => ++pages === 1 ? { from, nullifiers: [] } : original(from, limit);
    chain.submit = async cbor => { attempts++; return decodeTx(cbor).txId; };
    try {
      assert.equal((await owner.settle(request)).status, 'submitted');
      assert.ok(pages >= 3);
      assert.equal(attempts, 1);
    } finally { indexer.getNullifiers = original; chain.submit = submit; }
  });
  await t.test('REL-02: duplicate running and queued settles share promises', async () => {
    const before = submissions;
    const a = relayer.settle(requests[1]!);
    const b = relayer.settle(requests[2]!);
    const duplicateA = relayer.settle(requests[1]!);
    const duplicateB = relayer.settle(requests[2]!);
    // Attach rejection handlers even if the identity assertion fails during the red run.
    void duplicateA.catch(() => undefined);
    void duplicateB.catch(() => undefined);
    const firstResult = await a;
    assert.equal(submissions, before + 1);
    assert.equal(firstResult.status, 'submitted');
    mine();
    const secondResult = await b;
    assert.equal(secondResult.status, 'submitted');
    assert.equal(submissions, before + 2);
    mine();
    await Promise.allSettled([duplicateA, duplicateB]);
    assert.equal(a, duplicateA);
    assert.equal(b, duplicateB);
    for (const result of [firstResult, secondResult]) assert.equal((await relayer.getSettle(result.id)).status, 'confirmed');
    for (const seller of sellers.slice(1, 3)) {
      assert.equal((await chain.getUtxosAt(payer(seller).address)).reduce((sum, u) => sum + u.value.lovelace, 0n), 2_000_000n);
    }
  });
  await t.test('REL-05: an unchanged pool is uncertain after three reads and exposes a safe submitted status', async () => {
    const owner = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now, log: (message, error) => logs.push({ message, error }) });
    const request = await freshRequest(requests[3]!, owner);
    const original = chain.submit;
    const getUtxosAt = chain.getUtxosAt;
    let attempts = 0;
    let reads = 0;
    const underlying = new Error('private provider diagnostic');
    chain.submit = async () => { attempts++; throw underlying; };
    chain.getUtxosAt = async address => {
      if (attempts > 0 && address === ctx.deployment.scripts.pool.address) reads++;
      return getUtxosAt.call(chain, address);
    };
    try {
      await rejects(owner.settle(request), 'uncertain');
      assert.equal(attempts, 1);
      assert.equal(reads, 3);
      const submitted = await owner.getSettle(request.quoteId);
      assert.equal(submitted.status, 'submitted');
      assert.equal(submitted.error, null);
      assert.ok(logs.some(entry => entry.error === underlying));
    } finally { chain.submit = original; chain.getUtxosAt = getUtxosAt; }
  });
  await t.test('REL-05: a competing insertion mined during recovery permits a rebuilt settle', async () => {
    const current = await readPool(ctx);
    const plan = planInsert({ poolId: ctx.deployment.poolId, pool: current, config: (await readConfig(ctx)).datum, deposits: [] });
    assert.ok(plan);
    plan.flush = 1;
    plan.slots = plan.slots.slice(0, 1);
    const witness = insertWitness({ tree, slots: plan.slots });
    const proof = await prove(artifacts.insert, witness.input);
    const competing = await buildInsert(ctx, { payer: payer(keys.crank), pool: current, plan,
      proof: proof.cardano, newRoot: witness.newRoot });
    let failed = false;
    const owner = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now,
      log: message => { if (message === 'Could not build or submit the settle transaction') failed = true; } });
    const request = await freshRequest(requests[3]!, owner);
    const original = chain.submit;
    const getUtxosAt = chain.getUtxosAt;
    const height = chain.blocks().length;
    let reads = 0;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await submit(signTx(competing.cbor, [keys.crank]));
    chain.submit = async cbor => { attempts++; return submit(cbor); };
    chain.getUtxosAt = async address => {
      const outputs = await getUtxosAt.call(chain, address);
      if (failed && address === ctx.deployment.scripts.pool.address && ++reads === 1) {
        // The first recovery read still sees the input reserved in the mempool.
        timer = setTimeout(() => chain.mineBlock(), 0);
      }
      return outputs;
    };
    try {
      const result = await owner.settle(request);
      assert.equal(result.status, 'submitted');
      assert.ok(reads >= 2);
      assert.equal(attempts, 1, 'only the rebuilt transaction reaches submission');
      const view = decodeTx(chain.transaction(result.txHash)!.cbor);
      assert.ok(view.inputs.some(ref => ref.txId === competing.txId));
    } finally {
      clearTimeout(timer);
      chain.submit = original;
      chain.getUtxosAt = getUtxosAt;
      chain.rollback(chain.blocks().length - height);
    }
  });
  await t.test('REL-05: recovery stops when the quote expires during the wait', async () => {
    const owner = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
      quoteTtlMs: 600_000, retryDelayMs: 5, now: () => now });
    const request = await freshRequest(requests[3]!, owner);
    const original = chain.submit;
    const getUtxosAt = chain.getUtxosAt;
    const saved = now;
    let attempts = 0;
    let reads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    chain.submit = async () => { attempts++; throw new Error('Pool reserved by another transaction'); };
    chain.getUtxosAt = async address => {
      if (attempts > 0 && address === ctx.deployment.scripts.pool.address && ++reads === 1) {
        timer = setTimeout(() => { now = request.intent.validUntil; }, 0);
      }
      return getUtxosAt.call(chain, address);
    };
    try {
      await rejects(owner.settle(request), 'uncertain');
      assert.equal(attempts, 1);
      assert.equal(reads, 1);
      assert.equal((await owner.getSettle(request.quoteId)).status, 'submitted');
    } finally {
      clearTimeout(timer);
      chain.submit = original;
      chain.getUtxosAt = getUtxosAt;
      now = saved;
    }
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
      const before = submissions;
      // Mining eventually releases implementations that incorrectly queue the duplicate.
      const timer = setTimeout(mine, 1000);
      try {
        assert.deepEqual(await relayer.settle(requests[3]!), result);
        assert.equal(submissions, before);
      } finally { clearTimeout(timer); }
      mine();
      assert.equal((await relayer.getSettle(result.id)).status, 'confirmed');
      assert.equal((await readPool(ctx)).datum.queue.length, 2);
    } finally { chain.submit = original; }
  });
  await t.test('REL-01: old submissions expire after the default retention period during quote', async () => {
    const saved = now;
    try {
      now = first.intent.validUntil + 3_600_000 - 1;
      await relayer.quote(first.intent.payouts);
      assert.equal((await relayer.getSettle(first.quoteId)).status, 'confirmed');
      now++;
      await relayer.quote(first.intent.payouts);
      await rejects(relayer.getSettle(first.quoteId), 'not_found');
    } finally { now = saved; }
  });
});
