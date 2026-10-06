import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { serializeAddress } from '@meshsdk/core-cst';
import type { ClientCardanoSigner, FacilitatorCardanoSigner } from '@x402/cardano';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { deriveOneTimeKey } from '@zbase-cardano/crypto';
import { enterpriseAddress, keyHash } from '@zbase-cardano/txlib/keys';
import { buildStealthPayment, stealthFee } from '@zbase-cardano/txlib/stealth';
import { FakeChain } from '@zbase-cardano/txlib/testing/fake-chain';
import { decodeTx } from '@zbase-cardano/txlib/txview';
import type { Utxo } from '@zbase-cardano/txlib/types';
import { startSeller } from '../src/seller.js';

const payTo = serializeAddress({ pubKeyHash: '42'.repeat(28) }, 0);
const price = 2_000_000n;

async function fixture(confirmed = true) {
  const master = randomBytes(32);
  const oneTimeSeed = deriveOneTimeKey(master, 0);
  const buyerAddress = enterpriseAddress(master, 'preprod');
  master.fill(0);
  const address = enterpriseAddress(oneTimeSeed, 'preprod');
  const provider = new FakeChain({ network: 'preprod', startSlot: 100_000_000 });
  const ctx = { provider, network: 'preprod' as const };
  const fee = await stealthFee(ctx, { payTo, price });
  const oneTimeUtxo: Utxo = {
    ref: { txId: '11'.repeat(32), index: 300 }, address,
    value: { lovelace: price + fee, assets: {} }, inlineDatum: null, datumHash: null, scriptRef: null,
  };
  if (confirmed) provider.addUtxo(oneTimeUtxo);
  const calls = { submitted: [] as string[], signed: [] as string[], nonces: [] as string[], evaluations: 0, lookups: 0 };
  // Only chain access is replaced. The client, verifier, settlement, and seller stay stock.
  const chain: FacilitatorCardanoSigner = {
    getAddresses: () => [],
    async getUtxo(ref, network) {
      assert.equal(network, 'cardano:preprod');
      calls.lookups += 1;
      const u = provider.allUtxos().find(u => `${u.ref.txId}#${u.ref.index}` === ref);
      return u ? { exists: true, address: u.address, coin: u.value.lovelace, assets: u.value.assets,
        paymentKeyHash: Buffer.from(keyHash(oneTimeSeed)).toString('hex') } : { exists: false };
    },
    async getCurrentSlot() { return BigInt((await provider.getTip()).slot); },
    async getProtocolParameters() {
      const p = await provider.getProtocolParameters();
      return { coinsPerUtxoByte: p.coinsPerUtxoByte, minFeeCoefficient: p.minFeeA, minFeeConstant: p.minFeeB };
    },
    async evaluateTransaction(transaction) {
      calls.evaluations += 1;
      await provider.evaluate(Buffer.from(transaction, 'base64').toString('hex'));
    },
    async submitTransaction(transaction) {
      const txHash = await provider.submit(Buffer.from(transaction, 'base64').toString('hex'));
      calls.submitted.push(transaction);
      provider.mineBlock();
      provider.mineBlock();
      return { txHash, status: 'mempool' };
    },
    async getTransactionEvidence(hash) {
      const block = provider.transaction(hash)?.block;
      return block ? { status: 'confirmed', confirmations: provider.blocks().length - block.height }
        : { status: 'unknown', confirmations: 0 };
    },
  };
  const signer: ClientCardanoSigner = {
    getAddress: () => address,
    async buildAndSignPaymentTransaction(input) {
      assert.equal(input.network, 'cardano:preprod');
      assert.equal(input.asset, 'lovelace');
      assert.equal(input.payTo, payTo);
      assert.equal(input.amount, price.toString());
      const built = await buildStealthPayment(ctx, { oneTimeUtxo, oneTimeSeed,
        payTo: input.payTo, price: BigInt(input.amount), validForSlots: Math.min(240, input.maxTimeoutSeconds) });
      const transaction = Buffer.from(built.cbor, 'hex').toString('base64');
      const nonce = `${oneTimeUtxo.ref.txId}#${oneTimeUtxo.ref.index}`;
      calls.signed.push(transaction);
      calls.nonces.push(nonce);
      return { transaction, nonce };
    },
  };
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: 'cardano:preprod', client: new ExactCardanoScheme(signer) }],
    spendControls: { allowedAssets: [{ network: 'cardano:preprod', asset: 'lovelace', maxAmountPerPayment: price.toString() }] },
  });
  return { oneTimeSeed, oneTimeUtxo, buyerAddress, address, provider, chain, signer, paidFetch, calls };
}

test('SDK-04: stock fetch pays with leg 2 and releases weather after settlement', async t => {
  const f = await fixture();
  t.after(() => f.oneTimeSeed.fill(0));
  const server = await startSeller({ port: 0, network: 'cardano:preprod', payTo,
    priceLovelace: price, blockfrostProjectId: '', facilitatorSigner: f.chain });
  t.after(() => server.close());
  assert.equal(f.signer.getAddress(), f.address);
  const response = await f.paidFetch(`${server.url}/weather`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { weather: 'sunny', temperatureC: 28 });
  const settlement = decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')!);
  const view = decodeTx(Buffer.from(f.calls.signed[0]!, 'base64').toString('hex'));
  assert.equal(settlement.success, true);
  assert.equal(settlement.transaction, view.txId);
  assert.equal(settlement.extra?.status, 'confirmed');
  assert.equal(settlement.extra?.confirmations, 1);
  assert.deepEqual(f.calls.submitted, f.calls.signed);
  assert.equal(f.calls.submitted.length, 1);
  assert.deepEqual(f.calls.nonces, [`${f.oneTimeUtxo.ref.txId}#300`]);
  assert.ok(f.calls.lookups >= 2);
  assert.ok(f.calls.evaluations > 0);
  assert.deepEqual((await f.provider.getUtxosAt(payTo)).map(u => u.value.lovelace), [price]);
  assert.deepEqual(await f.provider.getUtxosAt(f.address), []);
});

test('SDK-04: an unconfirmed leg 1 cannot release weather or submit leg 2', async t => {
  const f = await fixture(false);
  t.after(() => f.oneTimeSeed.fill(0));
  const server = await startSeller({ port: 0, network: 'cardano:preprod', payTo,
    priceLovelace: price, blockfrostProjectId: '', facilitatorSigner: f.chain });
  t.after(() => server.close());
  const response = await f.paidFetch(`${server.url}/weather`);
  assert.equal(response.status, 402);
  assert.ok(!(await response.text()).includes('sunny'));
  assert.equal(response.headers.get('PAYMENT-RESPONSE'), null);
  assert.equal(f.calls.signed.length, 1);
  assert.ok(f.calls.lookups > 0);
  assert.equal(f.calls.submitted.length, 0);
  assert.deepEqual(await f.provider.getUtxosAt(payTo), []);
});

test('SDK-04: the seller receives only a one-time input and no output to the buyer', async t => {
  const f = await fixture();
  t.after(() => f.oneTimeSeed.fill(0));
  const server = await startSeller({ port: 0, network: 'cardano:preprod', payTo,
    priceLovelace: price, blockfrostProjectId: '', facilitatorSigner: f.chain });
  t.after(() => server.close());
  const response = await f.paidFetch(`${server.url}/weather`);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const view = decodeTx(Buffer.from(f.calls.submitted[0]!, 'base64').toString('hex'));
  assert.deepEqual(view.inputs, [f.oneTimeUtxo.ref]);
  assert.notEqual(f.oneTimeUtxo.address, f.buyerAddress);
  assert.equal(f.oneTimeUtxo.address, f.signer.getAddress());
  assert.deepEqual(view.witnessKeyHashes, [Buffer.from(keyHash(f.oneTimeSeed)).toString('hex')]);
  assert.equal(view.outputs.length, 1);
  assert.equal(view.outputs[0]!.address, payTo);
  assert.ok(view.outputs.every(output => output.address !== f.buyerAddress && output.address !== f.address));
});
