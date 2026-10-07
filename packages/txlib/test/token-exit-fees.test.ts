import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
  MerkleTree, addressToBech32, deriveNoteSecrets, insertWitness, precommitment, ragequitWitness,
} from '@zx402/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zx402/prover';
import * as txlib from '../src/index.js';
import { startDevnet, type Devnet } from '../src/testing/devnet.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const asset = { policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde', name: '0014df10745553444d' };
const unit = asset.policy + asset.name;
const proofOptions = {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent; token exits and fees need circuits/build/dev/manifest.json',
};
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const sumAda = (utxos: txlib.Utxo[]): bigint => utxos.reduce((sum, utxo) => sum + utxo.value.lovelace, 0n);
after(shutdown);

async function depositAndInsert(devnet: Devnet) {
  const { ctx, keys, run } = devnet;
  const user = keys.users[0]!;
  const payer = { address: txlib.enterpriseAddress(user, ctx.deployment.network) };
  const secrets = deriveNoteSecrets(user, 0);
  await run(await txlib.buildDeposit(ctx, { payer, amount: 10_000_000n,
    precommitment: precommitment(secrets.nullifier, secrets.secret), refundKeyHash: hex(txlib.keyHash(user)) }), [user]);
  const deposits = await txlib.readDeposits(ctx);
  assert.equal(deposits.length, 1);
  const pool = await txlib.readPool(ctx);
  const config = await txlib.readConfig(ctx);
  const plan = txlib.planInsert({ poolId: ctx.deployment.poolId, pool, config: config.datum, deposits, asset: devnet.asset });
  assert.ok(plan, 'A 10-token or 10-ADA deposit must produce an Insert plan');
  const witness = insertWitness({ tree: MerkleTree.empty(), slots: plan.slots });
  const proof = await prove(await loadDevArtifacts('insert', repoRoot), witness.input);
  assert.deepEqual(proof.publicSignals, witness.publicInputs);
  await run(await txlib.buildInsert(ctx, {
    payer: { address: txlib.enterpriseAddress(keys.crank, ctx.deployment.network) }, pool, plan,
    proof: proof.cardano, newRoot: witness.newRoot,
  }), [keys.crank]);
  const credited = plan.credited[0]!;
  return { payer, user, deposit: deposits[0]!, tree: witness.tree,
    note: { value: credited.value, label: credited.label, ...secrets } };
}

async function exitNote(devnet: Devnet, inserted: Awaited<ReturnType<typeof depositAndInsert>>) {
  const { ctx } = devnet;
  const pool = await txlib.readPool(ctx);
  const witness = ragequitWitness({ note: inserted.note, stateTree: inserted.tree, stateIndex: 0 });
  const proof = await prove(await loadDevArtifacts('ragequit', repoRoot), witness.input);
  assert.deepEqual(proof.publicSignals, witness.publicInputs);
  const trie = await txlib.nullifierInsertion([], witness.nullifierHash);
  const tx = await txlib.buildRagequit(ctx, {
    payer: inserted.payer, pool, proof: proof.cardano, nullifierHash: witness.nullifierHash,
    value: inserted.note.value, stateRoot: witness.stateRoot, depositRef: inserted.deposit.utxo.ref,
    refundKeyHash: hex(txlib.keyHash(inserted.user)), nullifierProof: trie.proofCbor,
    newNullifierRoot: trie.newRoot, payTo: inserted.payer.address,
  });
  return { tx, pool, trie };
}

test('TOKEN-11 Ragequit in a token pool', proofOptions, async t => {
  const devnet = await startDevnet({ asset });
  const inserted = await depositAndInsert(devnet);
  assert.equal(inserted.note.value, 10_000_000n);
  const { tx, pool, trie } = await exitNote(devnet, inserted);
  const view = txlib.decodeTx(tx.cbor);
  const exit = txlib.outputsOf(view)[1]!;
  const coinsPerByte = (await devnet.chain.getProtocolParameters()).coinsPerUtxoByte;
  const minimum = txlib.minimumLovelace(txlib.utxoToMesh(exit).output, coinsPerByte);
  assert.equal(exit.address, inserted.payer.address);
  assert.deepEqual(exit.value.assets, { [unit]: 10_000_000n });
  assert.equal(exit.value.lovelace, minimum);
  assert.deepEqual(view.requiredSigners, [hex(txlib.keyHash(inserted.user))]);
  const before = sumAda(await devnet.chain.getUtxosAt(inserted.payer.address));
  await devnet.run(tx, [inserted.user]);
  const next = await txlib.readPool(devnet.ctx);
  assert.equal(next.balance, 0n);
  assert.equal(Object.hasOwn(next.utxo.value.assets, unit), false);
  assert.deepEqual(next.utxo.value.assets, { [devnet.ctx.deployment.poolId + '706f6f6c']: 1n });
  assert.equal(next.utxo.value.lovelace, pool.utxo.value.lovelace);
  assert.notEqual(next.datum.nullifierRoot, pool.datum.nullifierRoot);
  assert.equal(next.datum.size, pool.datum.size);
  assert.deepEqual(next.datum, { ...pool.datum, nullifierRoot: trie.newRoot });
  const userOutputs = await devnet.chain.getUtxosAt(inserted.payer.address);
  // The user owns the exit too, so exclude it when measuring the funding wallet's debit.
  const fundingOutputs = userOutputs.filter(u => u.ref.txId !== tx.txId || u.ref.index !== 1);
  assert.equal(before - sumAda(fundingOutputs), minimum + tx.fee);
  assert.equal(sumAda(userOutputs), before - tx.fee);
  assert.deepEqual(userOutputs.find(u => u.ref.txId === tx.txId && u.ref.index === 1), exit);
  t.diagnostic(`Token exit minimum: ${minimum} lovelace; fee: ${tx.fee} lovelace`);
});

test('TOKEN-12 collect fees in a token pool', proofOptions, async t => {
  const devnet = await startDevnet({ asset });
  const { ctx, keys, chain, run } = devnet;
  const payer = { address: txlib.enterpriseAddress(keys.operator, ctx.deployment.network) };
  const config = (await txlib.readConfig(ctx)).datum;
  await run(await txlib.buildConfigUpdate(ctx, {
    payer, config: { ...config, depositFeeBps: 100 }, signers: config.admins,
  }), [keys.operator, ...keys.admin]);
  await depositAndInsert(devnet);
  const pool = await txlib.readPool(ctx);
  assert.equal(pool.datum.feesAccrued, 100_000n);
  assert.equal(pool.balance, 10_000_000n);
  const tx = await txlib.buildCollectFees(ctx, { payer, amount: 100_000n });
  const unchanged = chain.allUtxos();
  await assert.rejects(txlib.buildCollectFees(ctx, { payer, amount: 100_001n }), /exceeds accrued fees/);
  assert.deepEqual(chain.allUtxos(), unchanged);
  const treasury = txlib.outputsOf(txlib.decodeTx(tx.cbor))[1]!;
  const coinsPerByte = (await chain.getProtocolParameters()).coinsPerUtxoByte;
  const minimum = txlib.minimumLovelace(txlib.utxoToMesh(treasury).output, coinsPerByte);
  assert.equal(treasury.address, addressToBech32(config.treasury, ctx.deployment.network));
  assert.deepEqual(treasury.value.assets, { [unit]: 100_000n });
  assert.ok(treasury.value.lovelace >= minimum);
  const before = sumAda(await chain.getUtxosAt(payer.address));
  await run(tx, [keys.operator]);
  const next = await txlib.readPool(ctx);
  assert.equal(next.balance, 9_900_000n);
  assert.equal(next.utxo.value.assets[unit], 9_900_000n);
  assert.equal(next.datum.feesAccrued, 0n);
  assert.deepEqual(next.datum, { ...pool.datum, feesAccrued: 0n });
  assert.equal(next.utxo.value.lovelace, pool.utxo.value.lovelace);
  const payerOutputs = await chain.getUtxosAt(payer.address);
  // The operator is also the treasury, so its remaining funding must cover the payout's ADA.
  const fundingOutputs = payerOutputs.filter(u => u.ref.txId !== tx.txId || u.ref.index !== 1);
  assert.equal(before - sumAda(fundingOutputs), treasury.value.lovelace + tx.fee);
  assert.deepEqual((await chain.getUtxos([treasury.ref]))[0], treasury);
  t.diagnostic(`Token treasury minimum: ${minimum} lovelace; actual: ${treasury.value.lovelace} lovelace; fee: ${tx.fee} lovelace`);
});

test('TOKEN-13 ADA pool unchanged', proofOptions, async () => {
  const devnet = await startDevnet();
  const inserted = await depositAndInsert(devnet);
  assert.equal(inserted.note.value, 9_700_000n);
  const { tx, pool, trie } = await exitNote(devnet, inserted);
  const exit = txlib.outputsOf(txlib.decodeTx(tx.cbor))[1]!;
  assert.equal(exit.address, inserted.payer.address);
  assert.deepEqual(exit.value, { lovelace: 9_700_000n, assets: {} });
  const before = sumAda(await devnet.chain.getUtxosAt(inserted.payer.address));
  await devnet.run(tx, [inserted.user]);
  const next = await txlib.readPool(devnet.ctx);
  assert.equal(next.balance, pool.balance - 9_700_000n);
  assert.equal(next.utxo.value.lovelace, 6_000_000n);
  assert.deepEqual(next.utxo.value.assets, pool.utxo.value.assets);
  assert.deepEqual(next.datum, { ...pool.datum, nullifierRoot: trie.newRoot });
  assert.equal(sumAda(await devnet.chain.getUtxosAt(inserted.payer.address)), before + 9_700_000n - tx.fee);
});
