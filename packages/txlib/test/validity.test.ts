import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NETWORKS } from '@zx402/crypto';
import { buildDeposit, buildRefund, decodeTx, enterpriseAddress, keyHash, readDeposits, signTx } from '../src/index.js';
import { startDevnet } from '../src/testing/devnet.js';
import { LedgerError } from '../src/testing/fake-chain.js';

test('TX-03: refund validity expires before confirmation', async t => {
  const { ctx, chain, keys, run } = await startDevnet();
  chain.advanceSlots(NETWORKS[ctx.deployment.network].zeroSlot);
  const user = keys.users[0]!;
  const address = enterpriseAddress(user, ctx.deployment.network);
  await run(await buildDeposit(ctx, { payer: { address }, amount: 10_000_000n, precommitment: 42n,
    refundKeyHash: Buffer.from(keyHash(user)).toString('hex') }), [user]);
  const [deposit] = await readDeposits(ctx);
  const args = { payer: { address }, deposit: deposit!, payTo: address };
  const tip = await chain.getTip();
  const expired = (error: unknown) => error instanceof LedgerError && error.rule === 'outside_validity_interval';

  await t.test('TX-03: a past upper bound is refused', async st => {
    st.after(() => chain.rollback(0));
    const tx = await buildRefund(ctx, { ...args, invalidHereafter: tip.slot - 1 });
    await assert.rejects(chain.submit(signTx(tx.cbor, [user])), expired);
  });
  await t.test('TX-03: a future upper bound is encoded and enforced after acceptance', async () => {
    const upper = tip.slot + 100;
    const tx = await buildRefund(ctx, { ...args, invalidHereafter: upper });
    assert.equal(decodeTx(tx.cbor).invalidHereafter, upper);
    const signed = signTx(tx.cbor, [user]);
    assert.equal(await chain.submit(signed), tx.txId);
    assert.equal(chain.transaction(tx.txId)?.block, null);
    chain.advanceSlots(100);
    await assert.rejects(chain.submit(signed), expired);
    assert.equal(chain.transaction(tx.txId), undefined);
    assert.equal((await readDeposits(ctx)).length, 1);
  });
  await t.test('TX-03: omitting the upper bound preserves an unrestricted refund', async () => {
    const tx = await buildRefund(ctx, args);
    assert.equal(decodeTx(tx.cbor).invalidHereafter, null);
    await run(tx, [user]);
    assert.equal((await readDeposits(ctx)).length, 0);
  });
});
