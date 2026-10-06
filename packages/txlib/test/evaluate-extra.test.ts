import assert from 'node:assert/strict';
import { test } from 'node:test';
import { h2 } from '@zbase-cardano/crypto';
import { readDeposits } from '../src/context.js';
import { buildDeposit, buildRefund } from '../src/deposit.js';
import { enterpriseAddress, keyHash, signTx } from '../src/keys.js';
import { startDevnet } from '../src/testing/devnet.js';
import { decodeTx, outputsOf } from '../src/txview.js';
import type { Provider, Utxo } from '../src/types.js';

// Found on Preprod on 2026-10-06: Blockfrost's evaluator answered AdditionalUtxoOverlap for a refund.
// A live evaluator knows every confirmed output. It refuses one that is sent again, and Mesh's request
// format drops the datum and the script of what it sends. Extra inputs are only for outputs that are
// not on chain yet.
const key = (u: Utxo): string => `${u.ref.txId}#${u.ref.index}`;

async function setup() {
  const net = await startDevnet();
  const user = net.keys.users[0]!;
  const address = enterpriseAddress(user, net.ctx.deployment.network);
  const refundKeyHash = Buffer.from(keyHash(user)).toString('hex');
  const precommitment = h2(1n, 2n);
  const deposit = await buildDeposit(net.ctx, { payer: { address }, amount: 10_000_000n, precommitment, refundKeyHash });
  // Record what the builders send to the evaluator.
  const sent: string[][] = [];
  const chain = net.chain;
  const provider: Provider = {
    getUtxosAt: target => chain.getUtxosAt(target), getUtxos: refs => chain.getUtxos(refs),
    getProtocolParameters: () => chain.getProtocolParameters(), getTip: () => chain.getTip(), submit: cbor => chain.submit(cbor),
    evaluate: (cbor, additional = []) => { sent.push(additional.map(key).sort()); return chain.evaluate(cbor, additional); },
  };
  return { net, chain, user, address, refundKeyHash, precommitment, deposit, sent, ctx: { provider, deployment: net.ctx.deployment } };
}

test('TX-11: the fake evaluator refuses a confirmed output that is sent again', async () => {
  const { net, user, address, deposit } = await setup();
  await net.run(deposit, [user]);
  const [found] = await readDeposits(net.ctx);
  const refund = await buildRefund(net.ctx, { payer: { address }, deposit: found!, payTo: address });
  await assert.rejects(net.chain.evaluate(refund.cbor, [found!.utxo]), /AdditionalUtxoOverlap/);
  assert.equal((await net.chain.evaluate(refund.cbor)).length, 1);
});

test('TX-11: a refund of a confirmed deposit sends the evaluator no extra inputs', async () => {
  const { net, user, address, deposit, sent, ctx } = await setup();
  await net.run(deposit, [user]);
  const [found] = await readDeposits(ctx);
  const refund = await buildRefund(ctx, { payer: { address }, deposit: found!, payTo: address });
  assert.deepEqual(sent, [[]]);
  await net.run(refund, [user]);
});

test('TX-11: a refund chained on an unconfirmed deposit sends only the outputs that are not on chain', async () => {
  const { net, chain, user, address, refundKeyHash, precommitment, deposit, sent, ctx } = await setup();
  // Submitted, not mined: the deposit output and the change are in the mempool only.
  await chain.submit(signTx(deposit.cbor, [user]));
  const outputs = outputsOf(decodeTx(deposit.cbor));
  const pendingDeposit = outputs.find(o => o.address === net.ctx.deployment.scripts.deposit.address)!;
  const pendingChange = outputs.find(o => o.address === address)!;
  const spent = new Set(decodeTx(deposit.cbor).inputs.map(ref => `${ref.txId}#${ref.index}`));
  const confirmed = (await chain.getUtxosAt(address)).filter(u => !spent.has(key(u)));
  assert.ok(confirmed.length > 0, 'the user keeps a confirmed output for collateral');
  const refund = await buildRefund(ctx, {
    payer: { address, utxos: [pendingChange, ...confirmed] },
    deposit: { utxo: pendingDeposit, datum: { precommitment, refund: refundKeyHash } }, payTo: address,
  });
  assert.deepEqual(sent, [[key(pendingDeposit), key(pendingChange)].sort()]);
  await chain.submit(signTx(refund.cbor, [user]));
  chain.mineBlock();
  assert.equal(chain.blocks().at(-1)!.txIds.length, 2);
});
