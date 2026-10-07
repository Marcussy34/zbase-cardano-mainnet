import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Transaction, TxCBOR, serializeAddress } from '@meshsdk/core-cst';
import type { ClientCardanoSignInput, FacilitatorCardanoSigner } from '@x402/cardano';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import {
  decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader,
} from '@x402/core/http';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import {
  enterpriseAddress, keyHash, txId, verifyWitnesses, witnessKeyHashes,
} from '@zx402/txlib';
import { PREPROD_PARAMETERS, type Provider, type Utxo } from '@zx402/txlib';
import { decodeTx } from '@zx402/txlib';
import { keySigner } from '../src/key-signer.js';
import { startSeller } from '../src/seller.js';
import { payPlain } from '../src/pay-plain.js';

const payTo = serializeAddress({ pubKeyHash: '42'.repeat(28) }, 0);
const input: ClientCardanoSignInput = {
  network: 'cardano:preprod', payTo, asset: 'lovelace', amount: '2000000', maxTimeoutSeconds: 300,
};
const slot = 100_000_000;
const decode = (cbor: string) => Transaction.fromCbor(TxCBOR(cbor));

function fixture() {
  const seed = randomBytes(32);
  const address = enterpriseAddress(seed, 'preprod');
  const utxos: Utxo[] = ['11', '22'].map(hash => ({
    ref: { txId: hash.repeat(32), index: 0 }, address,
    value: { lovelace: 1_800_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null,
  }));
  const calls = { lookups: 0, evaluations: 0, submitted: [] as string[] };
  const provider: Provider = {
    async getUtxosAt(owner) { assert.equal(owner, address); return utxos; },
    async getUtxos(refs) {
      return utxos.filter(u => refs.some(r => r.txId === u.ref.txId && r.index === u.ref.index));
    },
    async getProtocolParameters() { return PREPROD_PARAMETERS; },
    async getTip() { return { slot, time: 0, blockHash: '33'.repeat(32) }; },
    async evaluate() { assert.fail('The buyer must leave evaluation to the facilitator'); },
    async submit() { assert.fail('The buyer must never submit'); },
  };
  const chain: FacilitatorCardanoSigner = {
    getAddresses: () => [],
    async getUtxo(ref, network) {
      assert.equal(network, 'cardano:preprod');
      calls.lookups += 1;
      const u = utxos.find(u => `${u.ref.txId}#${u.ref.index}` === ref);
      return u ? { exists: true, address, coin: u.value.lovelace, assets: {},
        paymentKeyHash: Buffer.from(keyHash(seed)).toString('hex') } : { exists: false };
    },
    async getCurrentSlot() { return BigInt(slot); },
    async getProtocolParameters() {
      return { coinsPerUtxoByte: 4310n, minFeeCoefficient: 44n, minFeeConstant: 155381n };
    },
    async evaluateTransaction() { calls.evaluations += 1; },
    async submitTransaction(transaction) {
      calls.submitted.push(transaction);
      return { txHash: txId(Buffer.from(transaction, 'base64').toString('hex')), status: 'mempool' };
    },
    async getTransactionEvidence(hash) {
      return calls.submitted.some(tx => txId(Buffer.from(tx, 'base64').toString('hex')) === hash)
        ? { status: 'confirmed', confirmations: 1 }
        : { status: 'unknown', confirmations: 0 };
    },
  };
  return { seed, address, utxos, provider, chain, calls };
}

async function seller(chain: FacilitatorCardanoSigner) {
  return startSeller({ port: 0, network: 'cardano:preprod', payTo, priceLovelace: 2_000_000n,
    blockfrostProjectId: '', facilitatorSigner: chain });
}

test('SDK-04 foundation: seller exposes health and stock lovelace payment requirements', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  const server = await seller(f.chain);
  t.after(() => server.close());
  assert.equal((await fetch(`${server.url}/health`)).status, 200);
  const response = await fetch(`${server.url}/weather`);
  assert.equal(response.status, 402);
  const required = decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED')!);
  assert.equal(required.x402Version, 2);
  assert.equal(required.accepts.length, 1);
  const accepted = required.accepts[0]!;
  assert.equal(accepted.scheme, 'exact');
  assert.equal(accepted.network, 'cardano:preprod');
  assert.equal(accepted.payTo, payTo);
  assert.equal(accepted.asset, 'lovelace');
  assert.equal(accepted.amount, '2000000');
  assert.equal(f.calls.lookups, 0);
  assert.equal((await fetch(`${server.url}/missing`)).status, 404);
});

test('SDK-04 foundation: raw key signs an exact payment with change and a consumed nonce', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  const signer = keySigner({ seed: f.seed, provider: f.provider, network: 'preprod' });
  assert.equal(signer.getAddress(), f.address);
  const result = await signer.buildAndSignPaymentTransaction(input);
  assert.ok(result.transaction.length > 0);
  const cbor = Buffer.from(result.transaction, 'base64').toString('hex');
  const tx = decode(cbor);
  const view = decodeTx(cbor);
  assert.deepEqual(view.mint, {});
  assert.equal(view.hasCertificates, false);
  assert.equal(view.hasWithdrawals, false);
  const outputs = tx.body().outputs();
  assert.equal(outputs.find(o => o.address().toBech32() === payTo)?.amount().coin(), 2_000_000n);
  assert.equal(outputs.length, 2);
  const change = outputs.find(o => o.address().toBech32() === f.address)!;
  assert.ok(change.amount().coin() > 0n);
  assert.equal(change.amount().coin() + 2_000_000n + tx.body().fee(), 3_600_000n);
  assert.ok(tx.body().fee() >= 155381n + 44n * BigInt(cbor.length / 2));
  const refs = tx.body().inputs().values().map(i => `${i.transactionId()}#${i.index()}`);
  assert.equal(refs.length, 2);
  assert.ok(refs.includes(result.nonce));
  assert.equal(tx.witnessSet().vkeys()?.size(), 1);
  assert.equal(verifyWitnesses(cbor), true);
  assert.deepEqual(witnessKeyHashes(cbor), [Buffer.from(keyHash(f.seed)).toString('hex')]);
  assert.ok(Number(tx.body().ttl()) > slot);
  assert.ok(Number(tx.body().ttl()) <= slot + input.maxTimeoutSeconds);
  assert.equal(f.calls.submitted.length, 0);
});

test('SDK-04 foundation: the signed payment verifies and settles through the stock facilitator', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  const server = await seller(f.chain);
  t.after(() => server.close());
  const unpaid = await fetch(`${server.url}/weather`);
  assert.equal(unpaid.status, 402);
  const required = decodePaymentRequiredHeader(unpaid.headers.get('PAYMENT-REQUIRED')!);
  const signed = await keySigner({ seed: f.seed, provider: f.provider, network: 'preprod' })
    .buildAndSignPaymentTransaction(required.accepts[0]!);
  const paid = await fetch(`${server.url}/weather`, { headers: {
    'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ x402Version: 2, resource: required.resource,
      accepted: required.accepts[0]!, payload: { ...signed } }),
  } });
  assert.equal(paid.status, 200, await paid.clone().text());
  assert.deepEqual(await paid.json(), { weather: 'sunny', temperatureC: 28 });
  const settlement = decodePaymentResponseHeader(paid.headers.get('PAYMENT-RESPONSE')!);
  assert.equal(settlement.success, true);
  assert.equal(settlement.transaction, txId(Buffer.from(signed.transaction, 'base64').toString('hex')));
  assert.equal(settlement.extra?.status, 'confirmed');
  assert.equal(settlement.extra?.confirmations, 1);
  assert.ok(f.calls.lookups >= 2);
  assert.ok(f.calls.evaluations > 0);
  assert.deepEqual(f.calls.submitted, [signed.transaction]);
});

test('SDK-04 foundation: stock fetch client opts into lovelace and completes the paid retry', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  const server = await seller(f.chain);
  t.after(() => server.close());
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: 'cardano:preprod', client: new ExactCardanoScheme(
      keySigner({ seed: f.seed, provider: f.provider, network: 'preprod' }),
    ) }],
    spendControls: { allowedAssets: [{ network: 'cardano:preprod', asset: 'lovelace', maxAmountPerPayment: '2000000' }] },
  });
  const response = await paidFetch(`${server.url}/weather`);
  assert.equal(response.status, 200);
  assert.equal(decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')!).success, true);
  assert.equal(f.calls.submitted.length, 1);
});

test('SDK-04 foundation: plain buyer returns the paid body and settlement hash', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  const server = await seller(f.chain);
  t.after(() => server.close());
  const result = await payPlain({ sellerUrl: server.url, seed: f.seed, provider: f.provider, network: 'preprod' });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { weather: 'sunny', temperatureC: 28 });
  assert.equal(f.calls.submitted.length, 1);
  assert.equal(result.transaction, txId(Buffer.from(f.calls.submitted[0]!, 'base64').toString('hex')));
});

test('SDK-04 foundation: plain buyer refuses a quote above its configured cap', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  const server = await seller(f.chain);
  t.after(() => server.close());
  await assert.rejects(payPlain({ sellerUrl: server.url, seed: f.seed, provider: f.provider,
    network: 'preprod', maxLovelace: 1_000_000n }));
  assert.equal(f.calls.submitted.length, 0);
});

test('SDK-04 foundation: unavailable funding never grants weather or submits a payment', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  f.chain.getUtxo = async () => ({ exists: false });
  const server = await seller(f.chain);
  t.after(() => server.close());
  const result = await payPlain({ sellerUrl: server.url, seed: f.seed, provider: f.provider, network: 'preprod' });
  assert.equal(result.status, 402);
  assert.equal(result.transaction, undefined);
  assert.ok(!result.body.includes('sunny'));
  assert.equal(f.calls.submitted.length, 0);
});

test('SDK-04 foundation: a failed evaluation never grants weather or submits a payment', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  f.chain.evaluateTransaction = async () => { throw new Error('offline evaluation rejection'); };
  const server = await seller(f.chain);
  t.after(() => server.close());
  const result = await payPlain({ sellerUrl: server.url, seed: f.seed, provider: f.provider, network: 'preprod' });
  assert.equal(result.status, 402);
  assert.equal(result.transaction, undefined);
  assert.ok(!result.body.includes('sunny'));
  assert.equal(f.calls.submitted.length, 0);
});

test('SDK-04 foundation: a rejected submission never releases weather', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  f.chain.submitTransaction = async () => { throw new Error('offline submission rejection'); };
  f.chain.isDefinitiveSubmissionRejection = () => true;
  const server = await seller(f.chain);
  t.after(() => server.close());
  const result = await payPlain({ sellerUrl: server.url, seed: f.seed, provider: f.provider, network: 'preprod' });
  assert.equal(result.status, 402);
  assert.ok(!result.body.includes('sunny'));
});

test('SDK-04 foundation: signer rejects incompatible requirements before consulting the provider', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  f.provider.getUtxosAt = async () => { assert.fail('Invalid requirements must not reach the provider'); };
  const signer = keySigner({ seed: f.seed, provider: f.provider, network: 'preprod' });
  const cases: Array<[Partial<ClientCardanoSignInput>, RegExp]> = [
    [{ network: 'cardano:mainnet' }, /network/],
    [{ asset: 'token' }, /lovelace/],
    [{ amount: '0' }, /positive integer/],
    [{ amount: '1.5' }, /positive integer/],
    [{ maxTimeoutSeconds: 0 }, /timeout/],
    [{ extra: { assetTransferMethod: 'masumi' } }, /ordinary/],
    [{ payTo: serializeAddress({ pubKeyHash: '42'.repeat(28) }, 1) }, /network/],
  ];
  for (const [change, reason] of cases) {
    await assert.rejects(async () => signer.buildAndSignPaymentTransaction({ ...input, ...change }), reason);
  }
});

test('SDK-04 foundation: signer rejects a price below minimum ADA instead of increasing it', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  const signer = keySigner({ seed: f.seed, provider: f.provider, network: 'preprod' });
  await assert.rejects(async () => signer.buildAndSignPaymentTransaction({ ...input, amount: '1' }), /minimum ADA/);
});

test('SDK-04 foundation: signer preserves native tokens in the buyer change', async t => {
  const f = fixture();
  t.after(() => f.seed.fill(0));
  const unit = `${'ab'.repeat(28)}01`;
  f.utxos[0]!.value = { lovelace: 5_000_000n, assets: { [unit]: 7n } };
  const result = await keySigner({ seed: f.seed, provider: f.provider, network: 'preprod' })
    .buildAndSignPaymentTransaction(input);
  const view = decodeTx(Buffer.from(result.transaction, 'base64').toString('hex'));
  assert.deepEqual(view.outputs.find(o => o.address === f.address)?.value.assets, { [unit]: 7n });
  assert.equal(view.outputs.find(o => o.address === payTo)?.value.lovelace, 2_000_000n);
});

test('SDK-04 foundation: command entry points reject invalid settings without leaking them', async () => {
  for (const script of ['seller', 'pay-plain']) {
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(`../src/${script}.ts`, import.meta.url))], {
      env: { NETWORK: 'invalid', BLOCKFROST_PROJECT_ID: 'test-project-value', BUYER_SEED_HEX: 'invalid-seed-value' },
    }), (error: Error & { code?: number; stdout?: string; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.ok(error.stderr?.includes(script === 'seller' ? 'Seller could not start' : 'Plain payment failed'));
      assert.ok(!error.stderr?.includes('test-project-value'));
      assert.ok(!error.stderr?.includes('invalid-seed-value'));
      return true;
    });
  }
});
