import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { toTxUnspentOutput } from '@meshsdk/core-cst';
import { MerkleTree, deriveNoteSecrets, insertWitness, precommitment } from '@zbase-cardano/crypto';
import { devKeysPresent, loadDevArtifacts, prove, shutdown } from '@zbase-cardano/prover';
import * as txlib from '../src/index.js';
import { startDevnet, type Devnet } from '../src/testing/devnet.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const ada = { policy: '', name: '' };
const asset = { policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde', name: '0014df10745553444d' };
const unit = asset.policy + asset.name;
after(shutdown);

function depositArgs(devnet: Devnet) {
  const user = devnet.keys.users[0]!;
  const secrets = deriveNoteSecrets(user, 0);
  return { payer: { address: txlib.enterpriseAddress(user, devnet.ctx.deployment.network) }, amount: 10_000_000n,
    precommitment: precommitment(secrets.nullifier, secrets.secret), refundKeyHash: Buffer.from(txlib.keyHash(user)).toString('hex') };
}

async function depositOn(devnet: Devnet) {
  await devnet.run(await txlib.buildDeposit(devnet.ctx, depositArgs(devnet)), [devnet.keys.users[0]!]);
  const deposits = await txlib.readDeposits(devnet.ctx);
  assert.equal(deposits.length, 1);
  return deposits[0]!;
}

test('TOKEN-01 asset helpers', () => {
  // Import the public namespace so missing helpers fail here without hiding the other tests.
  assert.equal(typeof txlib.assetUnit, 'function');
  assert.equal(txlib.isAdaAsset(ada), true);
  assert.equal(txlib.isAdaAsset(asset), false);
  assert.equal(txlib.isAdaAsset({ policy: '', name: '00' }), false);
  assert.equal(txlib.assetUnit(ada), 'lovelace');
  assert.equal(txlib.assetUnit(asset), unit);
  assert.equal(unit.length, 74);
  assert.equal(txlib.assetWireUnit(ada), 'lovelace');
  assert.equal(txlib.assetWireUnit(asset), `${asset.policy}.${asset.name}`);
  assert.deepEqual(txlib.parseAssetWireUnit(txlib.assetWireUnit(ada)), ada);
  assert.deepEqual(txlib.parseAssetWireUnit(txlib.assetWireUnit(asset)), asset);
  assert.deepEqual(txlib.parseAssetWireUnit(`${asset.policy.toUpperCase()}.${asset.name.toUpperCase()}`), asset);
  assert.deepEqual(txlib.parseAssetWireUnit(`${asset.policy}.`), { policy: asset.policy, name: '' });
  assert.equal(txlib.assetUnit({ policy: asset.policy, name: 'ab'.repeat(32) }).length, 120);
  for (const invalid of ['abc', unit, `${asset.policy}.0`, `${asset.policy}.${'aa'.repeat(33)}`, `${asset.policy}.gg`, `${asset.policy}.00.00`]) {
    assert.throws(() => txlib.parseAssetWireUnit(invalid), Error);
  }
  for (const invalid of [
    { ...asset, policy: 'ab' }, { ...asset, policy: 'gg'.repeat(28) }, { ...asset, policy: asset.policy.toUpperCase() },
    { ...asset, name: '00'.repeat(33) }, { ...asset, name: '0' }, { ...asset, name: 'GG' },
    { ...asset, name: asset.name.toUpperCase() }, { policy: '', name: '00' },
  ]) {
    assert.throws(() => txlib.assetUnit(invalid), Error);
    assert.throws(() => txlib.meshAsset(invalid, 1n), Error);
  }
  assert.deepEqual(txlib.meshAsset(ada, 10n), { unit: 'lovelace', quantity: '10' });
  assert.deepEqual(txlib.meshAsset(asset, 10_000_000n), { unit, quantity: '10000000' });
  const value = Object.freeze({ lovelace: 6_000_000n, assets: Object.freeze({ [unit]: 10n, other: 2n }) });
  assert.equal(txlib.assetAmount(value, ada), 6_000_000n);
  assert.equal(txlib.assetAmount(value, asset), 10n);
  assert.equal(txlib.assetAmount({ lovelace: 1n, assets: {} }, asset), 0n);
  assert.deepEqual(txlib.addAssetAmount(value, asset, 5n), { lovelace: 6_000_000n, assets: { [unit]: 15n, other: 2n } });
  assert.deepEqual(txlib.addAssetAmount(value, asset, -5n), { lovelace: 6_000_000n, assets: { [unit]: 5n, other: 2n } });
  assert.deepEqual(txlib.addAssetAmount(value, asset, -10n), { lovelace: 6_000_000n, assets: { other: 2n } });
  assert.deepEqual(txlib.addAssetAmount({ lovelace: 1n, assets: {} }, asset, 5n), { lovelace: 1n, assets: { [unit]: 5n } });
  assert.deepEqual(txlib.addAssetAmount(value, ada, 1n), { lovelace: 6_000_001n, assets: value.assets });
  const zeroAda = txlib.addAssetAmount(value, ada, -6_000_000n);
  assert.equal(zeroAda.lovelace, 0n);
  assert.notEqual(zeroAda.assets, value.assets);
  assert.throws(() => txlib.addAssetAmount(value, asset, -11n), RangeError);
  assert.throws(() => txlib.addAssetAmount(value, ada, -6_000_001n), RangeError);
  assert.deepEqual(value, { lovelace: 6_000_000n, assets: { [unit]: 10n, other: 2n } });
});

test('TOKEN-02 a token devnet', { timeout: 120_000 }, async () => {
  const token = await startDevnet({ asset });
  const standard = await startDevnet();
  assert.deepEqual(token.ctx.deployment.asset, asset);
  assert.deepEqual(token.asset, asset);
  assert.deepEqual(standard.asset, ada);
  assert.notEqual(token.ctx.deployment.scripts.pool.hash, standard.ctx.deployment.scripts.pool.hash);
  const pool = await txlib.readPool(token.ctx);
  assert.equal(pool.balance, 0n);
  assert.equal(pool.utxo.value.lovelace, 6_000_000n);
  assert.deepEqual(pool.utxo.value.assets, { [token.ctx.deployment.poolId + '706f6f6c']: 1n });
  const { datum: config } = await txlib.readConfig(token.ctx);
  assert.deepEqual([config.minDeposit, config.maxDeposit, config.poolCap, config.crankFee],
    [5_000_000n, 50_000_000n, 500_000_000n, 300_000n]);
  for (const user of token.keys.users) {
    const outputs = await token.chain.getUtxosAt(txlib.enterpriseAddress(user, token.ctx.deployment.network));
    assert.equal(outputs.length, 4);
    assert.deepEqual(outputs.filter(u => u.value.assets[unit]).map(u => u.value),
      [{ lovelace: 10_000_000n, assets: { [unit]: 1_000_000_000n } }]);
  }
  for (const key of [token.keys.operator, token.keys.relayer, token.keys.crank, token.keys.asp, ...token.keys.admin]) {
    const outputs = await token.chain.getUtxosAt(txlib.enterpriseAddress(key, token.ctx.deployment.network));
    assert.ok(outputs.every(u => (u.value.assets[unit] ?? 0n) === 0n));
  }
});

test('TOKEN-03 a token deposit output', { timeout: 120_000 }, async t => {
  const devnet = await startDevnet({ asset });
  const args = depositArgs(devnet);
  // Invalid amounts must fail before protocol parameters are requested to create a builder.
  const parameters = t.mock.method(devnet.chain, 'getProtocolParameters');
  await assert.rejects(txlib.buildDeposit(devnet.ctx, { ...args, amount: 4_000_000n }), RangeError);
  assert.equal(parameters.mock.callCount(), 0);
  parameters.mock.restore();
  const deposit = await depositOn(devnet);
  const coinsPerByte = (await devnet.chain.getProtocolParameters()).coinsPerUtxoByte;
  assert.deepEqual(deposit.utxo.value.assets, { [unit]: 10_000_000n });
  assert.equal(deposit.utxo.value.lovelace, txlib.minimumLovelace(txlib.utxoToMesh(deposit.utxo).output, coinsPerByte));
  const bytes = toTxUnspentOutput(txlib.utxoToMesh(deposit.utxo)).output().toCbor().length / 2;
  assert.equal(deposit.utxo.value.lovelace, coinsPerByte * BigInt(160 + bytes));
  assert.ok(deposit.utxo.value.lovelace >= 1_000_000n);
  assert.deepEqual(txlib.decodeDepositDatum(deposit.utxo.inlineDatum!), { precommitment: args.precommitment, refund: args.refundKeyHash });
  t.diagnostic(`10-token deposit minimum: ${deposit.utxo.value.lovelace} lovelace (${bytes} output bytes)`);
  const standard = await startDevnet();
  const adaDeposit = await depositOn(standard);
  assert.deepEqual(adaDeposit.utxo.value, { lovelace: 10_000_000n, assets: {} });
});

test('TOKEN-04 planInsert credits the whole token deposit', { timeout: 120_000 }, async () => {
  const devnet = await startDevnet({ asset });
  const deposit = await depositOn(devnet);
  const pool = await txlib.readPool(devnet.ctx);
  const { datum: config } = await txlib.readConfig(devnet.ctx);
  const args = { poolId: devnet.ctx.deployment.poolId, pool, config, deposits: [deposit], asset };
  const plan = txlib.planInsert(args);
  assert.ok(plan, 'A 10-token deposit must produce an Insert plan');
  assert.equal(plan.credited[0]!.value, 10_000_000n);
  assert.equal(plan.credited[0]!.fee, 0n);
  assert.deepEqual(plan.slots, [{ kind: 'deposit', value: 10_000_000n,
    label: plan.credited[0]!.label, precommitment: deposit.datum.precommitment }]);
  const withFee = txlib.planInsert({ ...args, config: { ...config, depositFeeBps: 100 } });
  assert.ok(withFee);
  assert.equal(withFee.credited[0]!.value, 9_900_000n);
  assert.equal(withFee.credited[0]!.fee, 100_000n);
  assert.equal(txlib.planInsert({ ...args, config: { ...config, poolCap: 9_999_999n } }), null);
  const standard = await startDevnet();
  const adaDeposit = await depositOn(standard);
  const adaArgs = { poolId: standard.ctx.deployment.poolId, pool: await txlib.readPool(standard.ctx),
    config: (await txlib.readConfig(standard.ctx)).datum, deposits: [adaDeposit] };
  const adaPlan = txlib.planInsert(adaArgs);
  assert.ok(adaPlan);
  assert.equal(adaPlan.credited[0]!.value, 10_000_000n - 300_000n);
  assert.deepEqual(txlib.planInsert({ ...adaArgs, asset: ada }), adaPlan);
});

test('TOKEN-05 Insert absorbs a token deposit', {
  timeout: 900_000,
  skip: devKeysPresent(repoRoot) ? false : 'Development proving keys are absent; token Insert needs circuits/build/dev/manifest.json',
}, async t => {
  const devnet = await startDevnet({ asset });
  const deposit = await depositOn(devnet);
  const pool = await txlib.readPool(devnet.ctx);
  const config = await txlib.readConfig(devnet.ctx);
  const plan = txlib.planInsert({ poolId: devnet.ctx.deployment.poolId, pool, config: config.datum, deposits: [deposit], asset });
  assert.ok(plan, 'A 10-token deposit must produce an Insert plan');
  const witness = insertWitness({ tree: MerkleTree.empty(), slots: plan.slots });
  const artifacts = await loadDevArtifacts('insert', repoRoot);
  const proof = await prove(artifacts, witness.input);
  assert.deepEqual(proof.publicSignals, witness.publicInputs);
  const address = txlib.enterpriseAddress(devnet.keys.crank, devnet.ctx.deployment.network);
  const totalAda = async () => (await devnet.chain.getUtxosAt(address)).reduce((sum, u) => sum + u.value.lovelace, 0n);
  const before = await totalAda();
  const tx = await txlib.buildInsert(devnet.ctx, { payer: { address }, pool, plan, proof: proof.cardano, newRoot: witness.newRoot });
  await devnet.run(tx, [devnet.keys.crank]);
  const after = await txlib.readPool(devnet.ctx);
  assert.equal(after.balance, 10_000_000n);
  assert.deepEqual(after.utxo.value.assets, { [devnet.ctx.deployment.poolId + '706f6f6c']: 1n, [unit]: 10_000_000n });
  assert.equal(after.utxo.value.lovelace, pool.utxo.value.lovelace);
  assert.equal(after.utxo.value.lovelace, 6_000_000n);
  assert.equal(after.datum.size, 1);
  assert.equal(after.datum.roots[0], witness.newRoot);
  assert.equal(after.datum.feesAccrued, 0n);
  assert.deepEqual(await txlib.readDeposits(devnet.ctx), []);
  assert.equal(await totalAda(), before + deposit.utxo.value.lovelace - tx.fee);
  assert.ok(await totalAda() >= before + deposit.utxo.value.lovelace - 1_000_000n);
  const view = txlib.decodeTx(tx.cbor);
  assert.deepEqual(view.mint, {});
  assert.equal(view.hasWithdrawals, false);
  assert.equal(view.hasCertificates, false);
  t.diagnostic(`Token Insert fee: ${tx.fee} lovelace; crank ADA gain: ${await totalAda() - before}`);
});
