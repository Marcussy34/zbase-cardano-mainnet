import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ed25519KeyHashHex, Hash, Transaction, TxCBOR } from '@meshsdk/core-cst';
import { R } from '@zbase-cardano/crypto';
import { buildDeposit, buildRefund } from '../src/deposit.js';
import { encodeDepositDatum } from '../src/codec.js';
import { readDeposits } from '../src/context.js';
import { enterpriseAddress, keyHash, signTx } from '../src/keys.js';
import { decodeTx, outputsOf } from '../src/txview.js';
import { startDevnet } from '../src/testing/devnet.js';
import { LedgerError } from '../src/testing/fake-chain.js';

test('TX-02, TX-08: deposit is a plain payment with the requested inline datum', async () => {
  const { ctx, chain, keys, run } = await startDevnet();
  const user = keys.users[0]!;
  const payer = { address: enterpriseAddress(user, ctx.deployment.network) };
  const refund = Buffer.from(keyHash(user)).toString('hex');
  const tx = await buildDeposit(ctx, { payer, amount: 10_000_000n, precommitment: 42n, refundKeyHash: refund });
  const view = decodeTx(tx.cbor);
  assert.deepEqual(view.mint, {});
  assert.equal(view.hasWithdrawals, false);
  assert.equal(view.hasCertificates, false);
  assert.deepEqual(view.collateral, []);
  assert.deepEqual(view.redeemers, []);
  assert.deepEqual(view.witnessScriptHashes, []);
  assert.deepEqual(view.witnessKeyHashes, []);
  assert.equal(view.outputs.filter(o => o.address === ctx.deployment.scripts.deposit.address).length, 1);
  await run(tx, [user]);
  const deposits = await readDeposits(ctx);
  assert.equal(deposits.length, 1);
  assert.equal(deposits[0]!.utxo.value.lovelace, 10_000_000n);
  assert.deepEqual(deposits[0]!.datum, { precommitment: 42n, refund });
  assert.ok(chain.transaction(tx.txId)?.block);
});

test('TX-02: deposit rejects each invalid amount and field element', async t => {
  const { ctx, keys } = await startDevnet();
  const user = keys.users[0]!;
  const args = {
    payer: { address: enterpriseAddress(user, ctx.deployment.network) },
    amount: 10_000_000n, precommitment: 42n, refundKeyHash: Buffer.from(keyHash(user)).toString('hex'),
  };
  for (const amount of [4_999_999n, 50_000_001n]) {
    await t.test(`amount ${amount}`, async () => assert.rejects(buildDeposit(ctx, { ...args, amount }), /amount/i));
  }
  for (const precommitment of [0n, -1n, R]) {
    await t.test(`precommitment ${precommitment}`, async () => assert.rejects(buildDeposit(ctx, { ...args, precommitment }), /precommitment/i));
  }
});

test('TX-03, TX-08: the refund key receives the full deposit and the payer supplies fees', async () => {
  const { ctx, chain, keys, run } = await startDevnet();
  const user = keys.users[0]!;
  const address = enterpriseAddress(user, ctx.deployment.network);
  await run(await buildDeposit(ctx, {
    payer: { address }, amount: 10_000_000n, precommitment: 42n, refundKeyHash: Buffer.from(keyHash(user)).toString('hex'),
  }), [user]);
  const [deposit] = await readDeposits(ctx);
  const payTo = enterpriseAddress(keys.users[1]!, ctx.deployment.network);
  const tx = await buildRefund(ctx, {
    payer: { address: enterpriseAddress(keys.relayer, ctx.deployment.network) }, deposit: deposit!, payTo,
  });
  const view = decodeTx(tx.cbor);
  assert.deepEqual(view.mint, {});
  assert.equal(view.hasWithdrawals, false);
  assert.equal(view.hasCertificates, false);
  assert.equal(view.redeemers.length, 1);
  assert.equal(view.collateral.length, 1);
  assert.deepEqual(view.referenceInputs, [ctx.deployment.refScripts.deposit]);
  assert.deepEqual(view.requiredSigners, [deposit!.datum.refund]);
  const measured = await chain.evaluate(tx.cbor);
  assert.equal(view.redeemers[0]!.mem, (measured[0]!.mem * 110n + 99n) / 100n);
  assert.equal(view.redeemers[0]!.steps, (measured[0]!.steps * 110n + 99n) / 100n);
  await assert.rejects(chain.submit(signTx(tx.cbor, [keys.relayer])), (e: unknown) => e instanceof LedgerError && e.rule === 'missing_signature');
  // Change only the claimed refund signer, then supply that key's valid witness.
  const forged = Transaction.fromCbor(TxCBOR(tx.cbor));
  const body = forged.body();
  const signers = body.requiredSigners()!;
  signers.setValues([Hash.fromCore(Ed25519KeyHashHex(Buffer.from(keyHash(keys.admin[0]!)).toString('hex')))]);
  body.setRequiredSigners(signers);
  forged.setBody(body);
  await assert.rejects(chain.submit(signTx(forged.toCbor(), [keys.relayer, keys.admin[0]!])),
    (e: unknown) => e instanceof LedgerError && e.rule === 'script_failure');
  await run(tx, [keys.relayer, user]);
  assert.equal((await readDeposits(ctx)).length, 0);
  assert.ok((await chain.getUtxosAt(payTo)).some(u => u.ref.txId === tx.txId && u.value.lovelace === 10_000_000n));
});

test('TX-03: deposit readers ignore missing and malformed datums', async () => {
  const { ctx, chain } = await startDevnet();
  for (const inlineDatum of [null, '00', 'd87980']) {
    chain.addUtxo({ address: ctx.deployment.scripts.deposit.address, value: { lovelace: 10_000_000n, assets: {} },
      inlineDatum, datumHash: null, scriptRef: null });
  }
  assert.deepEqual(await readDeposits(ctx), []);
});

test('TX-03: refund supports an unconfirmed deposit and rejects missing collateral', async () => {
  const { ctx, chain, keys, run } = await startDevnet();
  const user = keys.users[0]!;
  const address = enterpriseAddress(user, ctx.deployment.network);
  const datum = { precommitment: 42n, refund: Buffer.from(keyHash(user)).toString('hex') };
  const tx = await buildDeposit(ctx, { payer: { address }, amount: 10_000_000n, precommitment: datum.precommitment, refundKeyHash: datum.refund });
  await chain.submit(signTx(tx.cbor, [user]));
  const outputs = outputsOf(decodeTx(tx.cbor));
  const deposit = { utxo: outputs[0]!, datum };
  await assert.rejects(buildRefund(ctx, { payer: { address, utxos: [] }, deposit, payTo: address }), /collateral/i);
  const refund = await buildRefund(ctx, { payer: { address, utxos: outputs.filter(o => o.address === address) }, deposit, payTo: address });
  await run(refund, [user]);
  assert.deepEqual(await readDeposits(ctx), []);
});

test('TX-03: refund accepts an equivalent datum encoded with a definite list', async () => {
  const { ctx, chain, keys, run } = await startDevnet();
  const user = keys.users[0]!;
  const address = enterpriseAddress(user, ctx.deployment.network);
  const datum = { precommitment: 42n, refund: Buffer.from(keyHash(user)).toString('hex') };
  const inlineDatum = `d87982182a581c${datum.refund}`;
  assert.notEqual(inlineDatum, encodeDepositDatum(datum));
  chain.addUtxo({ address: ctx.deployment.scripts.deposit.address, inlineDatum, datumHash: null, scriptRef: null,
    value: { lovelace: 10_000_000n, assets: {} } });
  const [deposit] = await readDeposits(ctx);
  assert.deepEqual(deposit!.datum, datum);
  const refund = await buildRefund(ctx, { payer: { address }, deposit: deposit!, payTo: address });
  await run(refund, [user]);
  assert.deepEqual(await readDeposits(ctx), []);
});
