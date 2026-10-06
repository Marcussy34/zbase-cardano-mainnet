import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MeshTxBuilder } from '@meshsdk/core';
import {
  Datum, Hash32ByteBase16, normalizePlutusScript, resolvePlutusScriptAddress, toScriptRef, Transaction, TransactionOutput, TxCBOR,
} from '@meshsdk/core-cst';
import { enterpriseAddress, keyHash, signTx, txId } from '../src/keys.js';
import { decodeTx, outputsOf } from '../src/txview.js';

const seed = randomBytes(32);
const address = enterpriseAddress(seed);
const signer = Buffer.from(keyHash(seed)).toString('hex');
const amount = (quantity: number) => [{ unit: 'lovelace', quantity: String(quantity) }];
const builder = () => new MeshTxBuilder().setNetwork('mainnet');
const blueprint = JSON.parse(await readFile(new URL('./fixtures/stub.plutus.json', import.meta.url), 'utf8'));
const validator = blueprint.validators.find((v: { title: string }) => v.title === 'stub.stub.spend')!;
const script = { code: normalizePlutusScript(validator.compiledCode, 'DoubleCBOR'), version: 'V3' as const };
const scriptAddress = resolvePlutusScriptAddress(script, 1);

async function payment(): Promise<string> {
  return signTx(await builder()
    .txIn('bb'.repeat(32), 1, amount(10000000), address, 0)
    .txIn('aa'.repeat(32), 2, amount(10000000), address, 0)
    .txIn('aa'.repeat(32), 0, amount(10000000), address, 0)
    .txOut(address, amount(2000000)).invalidBefore(100).invalidHereafter(200)
    .changeAddress(address).complete(), [seed]);
}

test('TX-09 (shape): decode plain payment inputs in ledger order and preserve body fields', async () => {
  const cbor = await payment();
  const view = decodeTx(cbor);
  assert.equal(view.txId, txId(cbor));
  assert.equal(view.size, cbor.length / 2);
  assert.deepEqual(view.inputs, [
    { txId: 'aa'.repeat(32), index: 0 }, { txId: 'aa'.repeat(32), index: 2 },
    { txId: 'bb'.repeat(32), index: 1 },
  ]);
  assert.equal(view.outputs[0]!.address, address);
  assert.deepEqual(view.outputs[0]!.value, { lovelace: 2000000n, assets: {} });
  assert.equal(view.fee, Transaction.fromCbor(TxCBOR(cbor)).body().fee());
  assert.equal(view.outputs.reduce((sum, o) => sum + o.value.lovelace, view.fee), 30000000n);
  assert.equal(view.validFrom, 100);
  assert.equal(view.invalidHereafter, 200);
  assert.deepEqual(view.witnessKeyHashes, [signer]);
  assert.deepEqual(view.mint, {});
  assert.deepEqual(view.redeemers, []);
  assert.equal(view.hasWithdrawals, false);
  assert.equal(view.hasCertificates, false);
  assert.equal(view.totalCollateral, null);
  assert.equal(view.collateralReturn, null);
});

test('TX-05 (shape): decode reference script spend, collateral, datum, signer, and declared units', async () => {
  const size = normalizePlutusScript(script.code, 'SingleCBOR').length / 2;
  const cbor = await builder().spendingPlutusScriptV3()
    .txIn('80'.repeat(32), 0, amount(10000000), scriptAddress, 0)
    .spendingTxInReference('30'.repeat(32), 0, String(size), validator.hash)
    .txInInlineDatumPresent().txInRedeemerValue(0, 'Mesh', { mem: 1000000, steps: 100000000 })
    .txInCollateral('20'.repeat(32), 0, amount(5000000), address)
    .requiredSignerHash(signer).txOut(scriptAddress, amount(3000000)).txOutInlineDatumValue(42)
    .txOutReferenceScript(script.code, 'V3').invalidHereafter(200).changeAddress(address).complete();
  const view = decodeTx(cbor);
  assert.deepEqual(view.referenceInputs, [{ txId: '30'.repeat(32), index: 0 }]);
  assert.deepEqual(view.collateral, [{ txId: '20'.repeat(32), index: 0 }]);
  assert.equal(view.outputs[0]!.inlineDatum, '182a');
  assert.equal(view.outputs[0]!.datumHash, null);
  assert.deepEqual(view.outputs[0]!.scriptRef, { hash: validator.hash, cbor: toScriptRef(script).toCbor(), size });
  assert.deepEqual(view.requiredSigners, [signer]);
  assert.deepEqual(view.redeemers, [{ tag: 'spend', index: 0, dataCbor: '00', mem: 1000000n, steps: 100000000n }]);
  assert.deepEqual(view.witnessScriptHashes, []);
  assert.equal(view.validFrom, null);
});

test('TX-08 (decoder): unsigned mint and burn preserve asset names and witness script hashes', async () => {
  const policy = validator.hash;
  const token = policy + '01';
  const cbor = await builder()
    .txIn('10'.repeat(32), 0, [...amount(20000000), { unit: token, quantity: '5' }], address, 0)
    .mintPlutusScriptV3().mint('-2', policy, '01').mintingScript(script.code)
    .mintRedeemerValue(0, 'Mesh', { mem: 1000000, steps: 100000000 })
    .mintPlutusScriptV3().mint('7', policy, '02').mintingScript(script.code)
    .mintRedeemerValue(0, 'Mesh', { mem: 1000000, steps: 100000000 })
    .txInCollateral('20'.repeat(32), 0, amount(5000000), address)
    .changeAddress(address).complete();
  const view = decodeTx(cbor);
  assert.deepEqual(view.mint, { [token]: -2n, [policy + '02']: 7n });
  assert.deepEqual(view.witnessScriptHashes, [policy]);
  assert.deepEqual(view.outputs[0]!.value.assets, { [token]: 3n, [policy + '02']: 7n });
});

test('TX-09 (shape): outputsOf provides output indices and independent values for chaining', async () => {
  const view = decodeTx(await payment());
  const outputs = outputsOf(view);
  assert.equal(outputs.length, 2);
  outputs.forEach((output, index) => {
    assert.deepEqual(output.ref, { txId: view.txId, index });
    assert.deepEqual(output, { ref: { txId: view.txId, index }, ...view.outputs[index] });
  });
  outputs[0]!.value.lovelace = 0n;
  assert.equal(view.outputs[0]!.value.lovelace, 2000000n);
});

test('TX-05 (decoder): preserve hashed output datums and collateral return fields', async () => {
  const tx = Transaction.fromCbor(TxCBOR(await payment()));
  const body = tx.body();
  const outputs = body.outputs();
  outputs[0]!.setDatum(Datum.newDataHash(Hash32ByteBase16('77'.repeat(32))));
  outputs[0] = TransactionOutput.fromCore(outputs[0]!.toCore());
  body.setOutputs(outputs);
  body.setCollateralReturn(outputs[1]!);
  body.setTotalCollateral(1500000n);
  tx.setBody(body);
  const view = decodeTx(tx.toCbor());
  assert.equal(view.outputs[0]!.datumHash, '77'.repeat(32));
  assert.equal(view.outputs[0]!.inlineDatum, null);
  assert.equal(view.totalCollateral, 1500000n);
  assert.deepEqual(view.collateralReturn, view.outputs[1]);
});
