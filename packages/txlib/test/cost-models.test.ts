import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST } from '@meshsdk/common';
import { CborSet, CborWriter, Transaction, TransactionBody, TxCBOR, VkeyWitness } from '@meshsdk/core-cst';
import { blake2b } from '@noble/hashes/blake2.js';
import { PV11_COST_MODELS } from '../src/cost-models.js';
import { encodeDepositRedeemer } from '../src/codec.js';
import { complete, newTxBuilder, readDeposits } from '../src/context.js';
import { buildDeposit } from '../src/deposit.js';
import { enterpriseAddress, keyHash, signTx } from '../src/keys.js';
import { utxoToMesh } from '../src/providers/blockfrost.js';
import { startDevnet } from '../src/testing/devnet.js';
import { FakeChain, LedgerError } from '../src/testing/fake-chain.js';
import { PARAMETERS } from '../src/types.js';

async function refundSetup() {
  const devnet = await startDevnet({ users: 1 });
  const user = devnet.keys.users[0]!;
  const payer = { address: enterpriseAddress(user, 'preprod') };
  await devnet.run(await buildDeposit(devnet.ctx, {
    payer, amount: 10_000_000n, precommitment: 42n, refundKeyHash: Buffer.from(keyHash(user)).toString('hex'),
  }), [user]);
  const [deposit] = await readDeposits(devnet.ctx);
  const refund = async (chain: FakeChain, defaults = false) => {
    const ctx = { provider: chain, network: 'preprod' as const };
    const builder = await newTxBuilder(ctx);
    if (defaults) builder.setCostModels([DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST]);
    const { utxo, datum } = deposit!;
    const ref = devnet.ctx.deployment.refScripts.deposit;
    const script = devnet.ctx.deployment.scripts.deposit;
    const amount = utxoToMesh(utxo).output.amount;
    builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, amount, utxo.address, 0)
      .spendingTxInReference(ref.txId, ref.index, String(script.size), script.hash).txInInlineDatumPresent()
      .txInRedeemerValue(encodeDepositRedeemer('Refund'), 'CBOR').requiredSignerHash(datum.refund)
      .txOut(payer.address, amount);
    return signTx((await complete(ctx, builder, { payer })).cbor, [user]);
  };
  return { ...devnet, refund };
}

test('TX-10: refunds use provider cost models and the chain rejects Mesh defaults', async () => {
  const { chain, refund } = await refundSetup();
  const valid = await refund(chain);
  const wrong = await refund(chain, true);
  await assert.rejects(chain.submit(wrong), (error: unknown) => error instanceof LedgerError && error.rule === 'script_integrity');
  await chain.submit(valid);
});

// V3 uses language key 2 and a definite array of costs in the ledger language view.
function v3Hash(cbor: string, costs: number[]): string {
  const witnesses = Transaction.fromCbor(TxCBOR(cbor)).witnessSet();
  const writer = new CborWriter();
  writer.writeEncodedValue(Buffer.from(witnesses.redeemers()!.toCbor(), 'hex'));
  if (witnesses.plutusData()?.size()) writer.writeEncodedValue(Buffer.from(witnesses.plutusData()!.toCbor(), 'hex'));
  writer.writeStartMap(1);
  writer.writeInt(2);
  writer.writeStartArray(costs.length);
  costs.forEach(cost => writer.writeInt(cost));
  return Buffer.from(blake2b(writer.encode(), { dkLen: 32 })).toString('hex');
}

test('TX-10: Init commits to the full PV11 PlutusV3 language view', async () => {
  const { chain, ctx } = await startDevnet({ users: 0 });
  const cbor = chain.transaction(ctx.deployment.initTx)!.cbor;
  const actual = Transaction.fromCbor(TxCBOR(cbor)).body().scriptDataHash();
  assert.equal(actual, v3Hash(cbor, PV11_COST_MODELS.PlutusV3));
  assert.notEqual(actual, v3Hash(cbor, DEFAULT_V3_COST_MODEL_LIST));
});

test('TX-10: the chain checks its own parameters and accepts a refund built for them', async () => {
  const { chain, refund } = await refundSetup();
  const parameters = structuredClone(PARAMETERS.preprod);
  parameters.costModels = structuredClone(PV11_COST_MODELS);
  parameters.costModels.PlutusV3[0]! += 1;
  const changed = new FakeChain({ network: 'preprod', parameters, startSlot: (await chain.getTip()).slot });
  chain.allUtxos().forEach(utxo => changed.addUtxo(utxo));
  await assert.rejects(changed.submit(await refund(chain)),
    (error: unknown) => error instanceof LedgerError && error.rule === 'script_integrity');
  await changed.submit(await refund(changed));
});

test('TX-10: plain payments have no script data hash and redeemers require one', async () => {
  const { chain, keys, refund } = await refundSetup();
  const user = keys.users[0]!;
  const payer = { address: enterpriseAddress(user, 'preprod') };
  const ctx = { provider: chain, network: 'preprod' as const };
  const builder = await newTxBuilder(ctx);
  builder.txOut(payer.address, [{ unit: 'lovelace', quantity: '2000000' }]);
  const plain = await complete(ctx, builder, { payer });
  assert.equal(Transaction.fromCbor(TxCBOR(plain.cbor)).body().scriptDataHash(), undefined);
  await chain.submit(signTx(plain.cbor, [user]));
  chain.mineBlock();
  const tx = Transaction.fromCbor(TxCBOR(await refund(chain)));
  const body = tx.body().toCore();
  delete body.scriptIntegrityHash;
  tx.setBody(TransactionBody.fromCore(body));
  const witnesses = tx.witnessSet();
  witnesses.setVkeys(CborSet.fromCore([], VkeyWitness.fromCore));
  tx.setWitnessSet(witnesses);
  await assert.rejects(chain.submit(signTx(tx.toCbor(), [user])),
    (error: unknown) => error instanceof LedgerError && error.rule === 'script_integrity');
});

test('TX-10: PV11 has 332, 332, and 350 safe integer costs', () => {
  assert.deepEqual(Object.values(PV11_COST_MODELS).map(costs => costs.length), [332, 332, 350]);
  assert.ok(Object.values(PV11_COST_MODELS).every(costs => costs.every(Number.isSafeInteger)));
});
