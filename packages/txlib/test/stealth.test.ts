import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Transaction, TxCBOR } from '@meshsdk/core-cst';
import { addressToBech32, deriveOneTimeKey } from '@zbase-cardano/crypto';
import { enterpriseAddress, keyHash, verifyWitnesses } from '../src/keys.js';
import { buildStealthPayment, stealthFee } from '../src/stealth.js';
import { FakeChain, LedgerError } from '../src/testing/fake-chain.js';
import { decodeTx } from '../src/txview.js';
import { PREPROD_PARAMETERS, type Network, type Utxo } from '../src/types.js';

const slot = 100_000_000;
const destination = (kind: 'key' | 'script', stake: boolean, network: Network = 'preprod') => addressToBech32({
  payment: { kind, hash: new Uint8Array(28).fill(42) },
  stake: stake ? { kind: 'key', hash: new Uint8Array(28).fill(43) } : null,
}, network);
const payTo = destination('key', false);
const price = 2_500_000n;

async function fixture(options: { payTo?: string; price?: bigint; index?: number; network?: Network } = {}) {
  const network = options.network ?? 'preprod';
  const provider = new FakeChain({ network, startSlot: slot });
  const ctx = { provider, network };
  const seed = randomBytes(32);
  const payment = { payTo: options.payTo ?? payTo, price: options.price ?? price };
  const fee = await stealthFee(ctx, payment);
  const oneTimeUtxo: Utxo = {
    ref: { txId: '11'.repeat(32), index: options.index ?? 0 },
    address: enterpriseAddress(seed, network), value: { lovelace: payment.price + fee, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null,
  };
  provider.addUtxo(oneTimeUtxo);
  return { ctx, fee, args: { ...payment, oneTimeUtxo, oneTimeSeed: seed } };
}

test('TX-09: exact funding produces one signed input and one seller output accepted by FakeChain', async t => {
  const f = await fixture();
  t.after(() => f.args.oneTimeSeed.fill(0));
  const built = await buildStealthPayment(f.ctx, f.args);
  const view = decodeTx(built.cbor);
  assert.deepEqual(view.inputs, [f.args.oneTimeUtxo.ref]);
  assert.deepEqual(view.outputs, [{ address: payTo, value: { lovelace: price, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null }]);
  assert.equal(view.fee, f.args.oneTimeUtxo.value.lovelace - price);
  assert.equal(built.fee, view.fee);
  assert.equal(built.size, built.cbor.length / 2);
  assert.equal(built.txId, view.txId);
  assert.deepEqual(built.exUnits, []);
  assert.deepEqual(view.mint, {});
  assert.deepEqual(view.collateral, []);
  assert.deepEqual(view.referenceInputs, []);
  assert.deepEqual(view.redeemers, []);
  assert.deepEqual(view.requiredSigners, []);
  assert.equal(view.validFrom, null);
  assert.equal(view.invalidHereafter, slot + 240);
  assert.equal(view.hasCertificates, false);
  assert.equal(view.hasWithdrawals, false);
  const tx = Transaction.fromCbor(TxCBOR(built.cbor));
  assert.equal(tx.auxiliaryData(), undefined);
  assert.equal(tx.isValid(), true);
  assert.equal(tx.witnessSet().vkeys()?.size(), 1);
  assert.equal(verifyWitnesses(built.cbor), true);
  assert.deepEqual(view.witnessKeyHashes, [Buffer.from(keyHash(f.args.oneTimeSeed)).toString('hex')]);
  assert.equal(await f.ctx.provider.submit(built.cbor), built.txId);
  f.ctx.provider.mineBlock();
  assert.deepEqual((await f.ctx.provider.getUtxosAt(payTo)).map(u => u.value.lovelace), [price]);
  assert.deepEqual(await f.ctx.provider.getUtxosAt(f.args.oneTimeUtxo.address), []);
  t.diagnostic(`Leg 2: ${built.size} bytes, ${built.fee} lovelace fee`);
});

for (const kind of ['key', 'script'] as const) {
  for (const stake of [false, true]) {
    for (const amount of [1_000_000n, 2_500_000n, 1_000_000_000n]) {
      for (const index of [0, 300]) {
        test(`TX-09: quoted funding covers ${kind}, stake ${stake}, price ${amount}, index ${index}`, async t => {
          const f = await fixture({ payTo: destination(kind, stake), price: amount, index });
          t.after(() => f.args.oneTimeSeed.fill(0));
          const built = await buildStealthPayment(f.ctx, f.args);
          const view = decodeTx(built.cbor);
          assert.deepEqual(view.inputs, [f.args.oneTimeUtxo.ref]);
          assert.equal(view.outputs.length, 1);
          assert.equal(view.outputs[0]!.address, f.args.payTo);
          assert.equal(view.outputs[0]!.value.lovelace, amount);
          assert.equal(view.fee, f.fee);
          assert.ok(view.fee >= 155381n + 44n * BigInt(view.size));
          assert.equal(verifyWitnesses(built.cbor), true);
          await f.ctx.provider.submit(built.cbor);
          f.ctx.provider.mineBlock();
          assert.deepEqual((await f.ctx.provider.getUtxosAt(f.args.payTo)).map(u => u.value.lovelace), [amount]);
        });
      }
    }
  }
}

test('TX-09: funding at the signed minimum succeeds and one lovelace below fails', async t => {
  const f = await fixture();
  t.after(() => f.args.oneTimeSeed.fill(0));
  const first = await buildStealthPayment(f.ctx, f.args);
  const minimum = 155381n + 44n * BigInt(first.size);
  const exact = { ...f.args, oneTimeUtxo: { ...f.args.oneTimeUtxo, value: { lovelace: price + minimum, assets: {} } } };
  const built = await buildStealthPayment(f.ctx, exact);
  assert.equal(built.fee, minimum);
  assert.equal(built.size, first.size);
  exact.oneTimeUtxo.value.lovelace -= 1n;
  await assert.rejects(buildStealthPayment(f.ctx, exact), /minimum fee/i);
});

for (const [name, change, reason] of [
  ['token', { value: { lovelace: 3_000_000n, assets: { ['ab'.repeat(28)]: 1n } } }, /token|ADA.only|lovelace.only/i],
  ['another key', { address: destination('key', false) }, /one.time.*address|address.*one.time/i],
  ['inline datum', { inlineDatum: '00' }, /datum/i],
  ['datum hash', { datumHash: '00'.repeat(32) }, /datum/i],
  ['reference script', { scriptRef: { hash: '00'.repeat(28), cbor: '00', size: 1 } }, /reference script/i],
] satisfies Array<[string, Partial<Utxo>, RegExp]>) {
  test(`TX-09: rejects a one-time UTXO with ${name}`, async t => {
    const f = await fixture();
    t.after(() => f.args.oneTimeSeed.fill(0));
    const oneTimeUtxo = { ...f.args.oneTimeUtxo, ...change };
    // Keep the funding amount unchanged so the token case changes only the assets.
    if (name === 'token') oneTimeUtxo.value = { ...oneTimeUtxo.value, lovelace: f.args.oneTimeUtxo.value.lovelace };
    await assert.rejects(buildStealthPayment(f.ctx, { ...f.args, oneTimeUtxo }), reason);
  });
}

test('TX-09: rejects a price below minimum lovelace and a destination on another network', async t => {
  const f = await fixture();
  t.after(() => f.args.oneTimeSeed.fill(0));
  for (const [change, reason] of [
    [{ price: 1n }, /minimum.*lovelace|minimum ADA/i],
    [{ payTo: destination('key', false, 'mainnet') }, /network/i],
  ] as const) {
    const payment = { ...f.args, ...change };
    await assert.rejects(buildStealthPayment(f.ctx, payment), reason);
    await assert.rejects(stealthFee(f.ctx, payment), reason);
  }
});

test('TX-09: custom validity expires exactly at its upper bound', async t => {
  const f = await fixture();
  t.after(() => f.args.oneTimeSeed.fill(0));
  const built = await buildStealthPayment(f.ctx, { ...f.args, validForSlots: 37 });
  assert.equal(decodeTx(built.cbor).invalidHereafter, slot + 37);
  f.ctx.provider.advanceSlots(37);
  await assert.rejects(f.ctx.provider.submit(built.cbor), (error: unknown) =>
    error instanceof LedgerError && error.rule === 'outside_validity_interval');
});

test('TX-09: the fee quote covers integer width growth and live fee coefficients', async t => {
  const f = await fixture({ index: 300 });
  t.after(() => f.args.oneTimeSeed.fill(0));
  const provider = new FakeChain({ network: 'preprod', startSlot: 2 ** 32,
    parameters: { ...PREPROD_PARAMETERS, minFeeA: 1000n } });
  const ctx = { provider, network: 'preprod' as const };
  const fee = await stealthFee(ctx, { payTo, price });
  const oneTimeUtxo = { ...f.args.oneTimeUtxo, value: { lovelace: price + fee, assets: {} } };
  provider.addUtxo(oneTimeUtxo);
  const built = await buildStealthPayment(ctx, { ...f.args, oneTimeUtxo });
  assert.ok(built.fee >= 155381n + 1000n * BigInt(built.size));
  await provider.submit(built.cbor);
});

test('TX-09: two derived one-time keys share no input address or witness key hash', async t => {
  const master = randomBytes(32);
  const seeds = [deriveOneTimeKey(master, 0), deriveOneTimeKey(master, 1)];
  t.after(() => { master.fill(0); seeds.forEach(seed => seed.fill(0)); });
  const f = await fixture();
  t.after(() => f.args.oneTimeSeed.fill(0));
  const views = [];
  const addresses = [];
  for (const [index, oneTimeSeed] of seeds.entries()) {
    const address = enterpriseAddress(oneTimeSeed, 'preprod');
    const oneTimeUtxo = { ...f.args.oneTimeUtxo, address, ref: { txId: `${index + 2}`.repeat(64), index: 0 } };
    f.ctx.provider.addUtxo(oneTimeUtxo);
    const built = await buildStealthPayment(f.ctx, { ...f.args, oneTimeSeed, oneTimeUtxo });
    views.push(decodeTx(built.cbor));
    addresses.push(address);
    await f.ctx.provider.submit(built.cbor);
  }
  assert.notEqual(addresses[0], addresses[1]);
  assert.notEqual(views[0]!.witnessKeyHashes[0], views[1]!.witnessKeyHashes[0]);
  assert.notDeepEqual(views[0]!.inputs, views[1]!.inputs);
});
