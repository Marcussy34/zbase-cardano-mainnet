import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { toTxUnspentOutput } from '@meshsdk/core-cst';
import {
  NETWORKS, MerkleTree, commitment, contextFor, deriveNoteSecrets, deriveOneTimeKey,
  insertWitness, precommitment, spendWitness, type SettleIntent,
} from '@zbase-cardano/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zbase-cardano/prover';
import * as txlib from '../src/index.js';
import { startDevnet } from '../src/testing/devnet.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const ada = { policy: '', name: '' };
const asset = { policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde', name: '0014df10745553444d' };
const unit = asset.policy + asset.name;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
after(shutdown);

async function prepare(poolAsset = asset) {
  const devnet = await startDevnet({ asset: poolAsset });
  const { chain, ctx, keys, run } = devnet;
  const network = ctx.deployment.network;
  // Match Aiken's Shelley-era origin before binding the intent's expiry to slots.
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const payer = (key: Uint8Array) => ({ address: txlib.enterpriseAddress(key, network) });
  const user = keys.users[0]!;
  const secrets = deriveNoteSecrets(user, 0);
  await run(await txlib.buildDeposit(ctx, { payer: payer(user), amount: 10_000_000n,
    precommitment: precommitment(secrets.nullifier, secrets.secret), refundKeyHash: hex(txlib.keyHash(user)) }), [user]);
  const deposits = await txlib.readDeposits(ctx);
  assert.equal(deposits.length, 1);
  const poolBeforeInsert = await txlib.readPool(ctx);
  const config = await txlib.readConfig(ctx);
  const plan = txlib.planInsert({ poolId: ctx.deployment.poolId, pool: poolBeforeInsert,
    config: config.datum, deposits, asset: poolAsset });
  assert.ok(plan);
  const insert = insertWitness({ tree: MerkleTree.empty(), slots: plan.slots });
  const insertProof = await prove(await loadDevArtifacts('insert', repoRoot), insert.input);
  assert.deepEqual(insertProof.publicSignals, insert.publicInputs);
  await run(await txlib.buildInsert(ctx, { payer: payer(keys.crank), pool: poolBeforeInsert,
    plan, proof: insertProof.cardano, newRoot: insert.newRoot }), [keys.crank]);
  const note = { ...secrets, value: plan.credited[0]!.value, label: plan.credited[0]!.label };
  const aspTree = MerkleTree.fromLeaves([note.label]);
  await run(await txlib.buildAspUpdate(ctx, { payer: payer(keys.asp), root: aspTree.root,
    signers: [hex(txlib.keyHash(keys.asp))] }), [keys.asp]);
  assert.equal((await txlib.readAsp(ctx)).datum.root, aspTree.root);
  const pool = await txlib.readPool(ctx);
  const oneTimeSeed = deriveOneTimeKey(user, 0);
  const intent: SettleIntent = {
    poolId: Buffer.from(ctx.deployment.poolId, 'hex'),
    payouts: [{ address: { payment: { kind: 'key', hash: txlib.keyHash(oneTimeSeed) }, stake: null }, amount: 2_000_000n, datumHash: null }],
    relayer: txlib.keyHash(keys.relayer), validUntil: BigInt((await chain.getTip()).time + 300_999),
  };
  const fresh = deriveNoteSecrets(user, 1);
  const witness = spendWitness({ note, stateTree: insert.tree, stateIndex: 0, aspTree, aspIndex: 0,
    withdrawn: 3_000_000n, newNullifier: fresh.nullifier, newSecret: fresh.secret, context: contextFor(intent) });
  const proof = await prove(await loadDevArtifacts('spend', repoRoot), witness.input);
  assert.deepEqual(proof.publicSignals, witness.publicInputs);
  const trie = await txlib.nullifierInsertion([], witness.public.nullifierHash);
  assert.equal(trie.oldRoot, pool.datum.nullifierRoot);
  const args = { payer: payer(keys.relayer), pool, proof: proof.cardano,
    nullifierHash: witness.public.nullifierHash, newCommitment: witness.public.newCommitment,
    withdrawn: 3_000_000n, stateRoot: witness.public.stateRoot, intent,
    nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot };
  return { ...devnet, network, payer, oneTimeSeed, args, witness };
}

test('TOKEN-08 to TOKEN-10: real proof token payment story', {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent; token Settle needs circuits/build/dev/manifest.json',
}, async t => {
  const f = await prepare();
  t.after(() => f.oneTimeSeed.fill(0));
  const { chain, ctx, keys, args } = f;
  const oneTimeAddress = f.payer(f.oneTimeSeed).address;
  const balances = async () => (await chain.getUtxosAt(args.payer.address)).reduce((sum, u) => ({
    lovelace: sum.lovelace + u.value.lovelace, tokens: sum.tokens + (u.value.assets[unit] ?? 0n),
  }), { lovelace: 0n, tokens: 0n });
  let settled: txlib.BuiltTx | undefined;
  async function settle() {
    if (!settled) {
      const tx = await txlib.buildSettle(ctx, { ...args, payoutLovelace: 2_000_000n });
      await f.run(tx, [keys.relayer]);
      settled = tx;
    }
    return settled;
  }

  await t.test('TOKEN-08 Settle in a token pool', async step => {
    const before = await balances();
    const tx = await settle();
    const pool = await txlib.readPool(ctx);
    assert.equal(pool.balance, 7_000_000n);
    assert.deepEqual(pool.utxo.value.assets, { [ctx.deployment.poolId + '706f6f6c']: 1n, [unit]: 7_000_000n });
    assert.equal(pool.utxo.value.lovelace, args.pool.utxo.value.lovelace);
    const payout = txlib.decodeTx(tx.cbor).outputs[1]!;
    assert.equal(payout.address, oneTimeAddress);
    assert.deepEqual(payout.value, { lovelace: 2_000_000n, assets: { [unit]: 2_000_000n } });
    assert.equal(payout.inlineDatum, null);
    assert.equal(payout.datumHash, null);
    assert.equal(payout.scriptRef, null);
    const after = await balances();
    assert.equal(after.tokens - before.tokens, 1_000_000n);
    assert.ok(before.lovelace - after.lovelace > 2_000_000n);
    assert.equal(before.lovelace - after.lovelace, 2_000_000n + tx.fee);
    assert.deepEqual(pool.datum.queue, [commitment(f.witness.changeNote)]);
    assert.equal(pool.datum.feesAccrued, 0n);
    assert.equal(pool.datum.nullifierRoot, args.newNullifierRoot);
    assert.deepEqual(pool.datum.roots, args.pool.datum.roots);
    assert.equal(pool.datum.size, args.pool.datum.size);
    step.diagnostic(`Token Settle fee: ${tx.fee} lovelace; relayer token gain: ${after.tokens - before.tokens} base units`);
  });

  await t.test('TOKEN-09 the payout ADA floor', async step => {
    const parameters = await chain.getProtocolParameters();
    const output = { address: oneTimeAddress,
      amount: [{ unit: 'lovelace', quantity: '2000000' }, { unit, quantity: '2000000' }] };
    const bytes = toTxUnspentOutput({ input: { txHash: '00'.repeat(32), outputIndex: 0 }, output }).output().toCbor().length / 2;
    const minimum = parameters.coinsPerUtxoByte * BigInt(160 + bytes);
    step.diagnostic(`Two-token payout minimum: ${minimum} lovelace (${bytes} output bytes)`);
    for (const [name, payoutLovelace, reason] of [
      ['below minimum', 500_000n, new RegExp(`minimum.*${minimum}`, 'i')],
      ['missing ADA', undefined, /A token pool settle needs payoutLovelace/],
      ['zero ADA', 0n, /payoutLovelace/],
      ['negative ADA', -1n, /payoutLovelace/],
    ] as const) {
      await step.test(`TOKEN-09 rejects ${name} before submission`, async () => {
        const before = chain.allUtxos();
        const invalid = payoutLovelace === undefined ? args : { ...args, payoutLovelace };
        await assert.rejects(txlib.buildSettle(ctx, invalid), reason);
        assert.deepEqual(chain.allUtxos(), before);
      });
    }
    await step.test('TOKEN-09 ADA pools reject payoutLovelace but accept zero', async () => {
      const standard = await prepare(ada);
      try {
        const before = standard.chain.allUtxos();
        const absent = await txlib.buildSettle(standard.ctx, standard.args);
        const zero = await txlib.buildSettle(standard.ctx, { ...standard.args, payoutLovelace: 0n });
        assert.equal(zero.cbor, absent.cbor);
        await assert.rejects(txlib.buildSettle(standard.ctx, { ...standard.args, payoutLovelace: 1n }), /ADA.*payoutLovelace/i);
        assert.deepEqual(standard.chain.allUtxos(), before);
      } finally {
        standard.oneTimeSeed.fill(0);
      }
    });
  });

  await t.test('TOKEN-10 leg 2 after a settle', async step => {
    // Reuse TOKEN-08's output, but still exercise the Settle guard if that test failed.
    await settle();
    const [oneTimeUtxo] = await chain.getUtxosAt(oneTimeAddress);
    assert.ok(oneTimeUtxo);
    const payTo = txlib.enterpriseAddress(new Uint8Array(32).fill(100), f.network);
    const payment = { payTo, price: 2_000_000n, asset };
    const legContext = { provider: chain, network: f.network };
    const built = await txlib.buildStealthPayment(legContext, { ...payment, oneTimeUtxo, oneTimeSeed: f.oneTimeSeed });
    assert.equal(await chain.submit(built.cbor), built.txId);
    chain.mineBlock();
    const outputs = await chain.getUtxosAt(payTo);
    assert.equal(outputs.length, 1);
    assert.deepEqual(outputs[0]!.value.assets, { [unit]: 2_000_000n });
    const minimum = await txlib.sellerMinimumLovelace(legContext, payment);
    assert.ok(outputs[0]!.value.lovelace >= minimum);
    assert.equal(outputs[0]!.value.lovelace, 2_000_000n - built.fee);
    assert.deepEqual(await chain.getUtxosAt(oneTimeAddress), []);
    step.diagnostic(`Token seller minimum: ${minimum} lovelace; leg 2 fee: ${built.fee} lovelace`);
  });
});
