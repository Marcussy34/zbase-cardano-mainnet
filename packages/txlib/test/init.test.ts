import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transaction, TxCBOR, toTxUnspentOutput } from '@meshsdk/core-cst';
import { R } from '@zbase-cardano/crypto';
import { readAsp, readConfig, readPool, newTxBuilder, vkFromHex, vkToHex } from '../src/context.js';
import { encodePoolDatum, encodeVoid } from '../src/codec.js';
import { buildPublishScripts } from '../src/init.js';
import { enterpriseAddress, signTx } from '../src/keys.js';
import { utxoToMesh } from '../src/providers/blockfrost.js';
import { decodeTx } from '../src/txview.js';
import { startDevnet } from '../src/testing/devnet.js';
import { FakeChain, LedgerError } from '../src/testing/fake-chain.js';

test('TX-01: devnet publishes scripts and creates the three genesis outputs', async t => {
  const { chain, ctx, keys } = await startDevnet();
  const { deployment: d } = ctx;
  const pool = await readPool(ctx);
  assert.equal(pool.utxo.value.lovelace, 6_000_000n);
  assert.deepEqual(pool.utxo.value.assets, { [d.poolId + '706f6f6c']: 1n });
  assert.equal(pool.balance, 6_000_000n);
  assert.deepEqual(pool.datum, {
    roots: [34147729537948564452788589313828361831422685361580832702235439851958634889397n],
    size: 0, queue: [], nullifierRoot: '00'.repeat(32), feesAccrued: 0n,
  });
  const config = await readConfig(ctx);
  const asp = await readAsp(ctx);
  assert.equal(config.utxo.value.assets[d.poolId + '636f6e666967'], 1n);
  assert.equal(asp.utxo.value.assets[d.poolId + '617370'], 1n);
  assert.equal(config.datum.minDeposit, 5_000_000n);
  assert.equal(config.datum.maxDeposit, 50_000_000n);
  assert.equal(config.datum.poolCap, 500_000_000n);
  assert.equal(config.datum.crankFee, 300_000n);
  assert.equal(config.datum.depositsPaused, false);
  assert.equal(config.datum.adminThreshold, 1);
  assert.equal(asp.datum.threshold, 1);
  assert.equal(asp.datum.root, pool.datum.roots[0]);
  assert.deepEqual([pool.utxo.ref.index, config.utxo.ref.index, asp.utxo.ref.index], [0, 1, 2]);
  assert.equal(JSON.parse(JSON.stringify(d)).poolId, d.poolId);
  assert.deepEqual(vkToHex(vkFromHex(d.vkeys.spend)), d.vkeys.spend);
  const parameters = await chain.getProtocolParameters();
  for (const name of ['pool', 'deposit', 'config', 'asp'] as const) {
    const [reference] = await chain.getUtxos([d.refScripts[name]]);
    assert.ok(reference?.scriptRef);
    assert.equal(reference.scriptRef.hash, d.scripts[name].hash);
    assert.equal(reference.scriptRef.size, d.scripts[name].size);
    const output = toTxUnspentOutput(utxoToMesh(reference)).output();
    assert.equal(reference.value.lovelace, parameters.coinsPerUtxoByte * BigInt(160 + output.toCbor().length / 2));
    t.diagnostic(`${name} reference locks ${reference.value.lovelace} lovelace; script ${reference.scriptRef.size} bytes`);
  }
  const history = chain.blocks().flatMap(block => block.txIds);
  assert.equal(history.length, 3);
  const first = decodeTx(chain.transaction(history[0]!)!.cbor);
  const second = decodeTx(chain.transaction(history[1]!)!.cbor);
  assert.ok(second.inputs.some(input => input.txId === first.txId && input.index === 1));
  for (const id of history) {
    const view = decodeTx(chain.transaction(id)!.cbor);
    assert.equal(view.hasWithdrawals, false);
    assert.equal(view.hasCertificates, false);
    assert.equal(Object.keys(view.mint).length, id === d.initTx ? 3 : 0);
    t.diagnostic(`${id === d.initTx ? 'Init' : 'Publish'}: ${view.size} signed bytes, ${view.fee} lovelace fee`);
  }
  for (const seed of [keys.operator, keys.relayer, keys.crank, keys.asp, ...keys.admin, ...keys.users]) {
    assert.ok((await chain.getUtxosAt(enterpriseAddress(seed, d.network))).some(u => u.value.lovelace === 5_000_000n));
  }
});

test('TX-01: Init without the policy seed fails the real minting policy', async () => {
  const { chain, ctx, keys } = await startDevnet();
  const original = decodeTx(chain.transaction(ctx.deployment.initTx)!.cbor);
  chain.rollback(1);
  const address = enterpriseAddress(keys.operator, ctx.deployment.network);
  const available = await chain.getUtxosAt(address);
  const input = available.find(u => u.ref.txId !== ctx.deployment.seed.txId && u.value.lovelace >= 20_000_000n && !u.scriptRef)!;
  const collateral = available.find(u => u.value.lovelace === 5_000_000n)!;
  const builder = await newTxBuilder({ provider: chain, network: ctx.deployment.network });
  builder.txIn(input.ref.txId, input.ref.index, utxoToMesh(input).output.amount, address, 0)
    .txInCollateral(collateral.ref.txId, collateral.ref.index, utxoToMesh(collateral).output.amount, address);
  for (const name of ['706f6f6c', '636f6e666967', '617370']) {
    builder.mintPlutusScriptV3().mint('1', ctx.deployment.poolId, name)
      .mintingScript(ctx.deployment.scripts.nft.cbor).mintRedeemerValue(encodeVoid(), 'CBOR', { mem: 2_000_000, steps: 1_000_000_000 });
  }
  for (const output of original.outputs.slice(0, 3)) {
    builder.txOut(output.address, [
      { unit: 'lovelace', quantity: String(output.value.lovelace) },
      ...Object.entries(output.value.assets).map(([unit, quantity]) => ({ unit, quantity: String(quantity) })),
    ]).txOutInlineDatumValue(output.inlineDatum!, 'CBOR');
  }
  const cbor = await builder.changeAddress(address).setFee('1000000').complete();
  await assert.rejects(chain.submit(signTx(cbor, [keys.operator])), (e: unknown) => e instanceof LedgerError && e.rule === 'script_failure');
});

test('TX-01: the largest pool datum fits inside the 6 ADA reserve', async t => {
  const { chain, ctx } = await startDevnet();
  const pool = (await readPool(ctx)).utxo;
  pool.inlineDatum = encodePoolDatum({
    roots: Array<bigint>(16).fill(R - 1n), size: 2 ** 32, queue: Array<bigint>(8).fill(R - 1n),
    nullifierRoot: 'ff'.repeat(32), feesAccrued: (1n << 64n) - 1n,
  });
  const bytes = toTxUnspentOutput(utxoToMesh(pool)).output().toCbor().length / 2;
  const minimum = (await chain.getProtocolParameters()).coinsPerUtxoByte * BigInt(160 + bytes);
  assert.ok(minimum < 6_000_000n);
  t.diagnostic(`Largest pool output: ${bytes} bytes; minimum ${minimum} lovelace`);
});

test('TX-01: devnet also deploys with mainnet address encoding', async () => {
  const { chain, ctx } = await startDevnet({ network: 'mainnet', users: 1 });
  assert.equal(ctx.deployment.network, 'mainnet');
  assert.match((await readPool(ctx)).utxo.address, /^addr1/);
  assert.equal(chain.blocks().length, 3);
  const init = Transaction.fromCbor(TxCBOR(chain.transaction(ctx.deployment.initTx)!.cbor));
  assert.ok(init.witnessSet().vkeys()!.size() > 0);
});

test('TX-01: script publication chains change and also uses remaining payer inputs', async () => {
  const { ctx, keys } = await startDevnet();
  const chain = new FakeChain({ network: ctx.deployment.network });
  const address = enterpriseAddress(keys.operator, ctx.deployment.network);
  for (let i = 0; i < 2; i += 1) chain.addUtxo({ address, value: { lovelace: 30_000_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null });
  const { txs } = await buildPublishScripts({ provider: chain, network: ctx.deployment.network }, {
    payer: { address }, scripts: ctx.deployment.scripts, holder: address,
  });
  assert.ok(decodeTx(txs[1]!.cbor).inputs.some(input => input.txId === txs[0]!.txId && input.index === 1));
  for (const tx of txs) await chain.submit(signTx(tx.cbor, [keys.operator]));
  chain.mineBlock();
  assert.equal(chain.blocks()[0]!.txIds.length, 2);
});

test('TX-01: repeatable devnet deployment does not depend on coin selection randomness', async t => {
  const random = t.mock.method(Math, 'random', () => 0);
  const first = await startDevnet();
  random.mock.mockImplementation(() => 0.999999);
  const second = await startDevnet();
  assert.deepEqual(second.ctx.deployment, first.ctx.deployment);
});
