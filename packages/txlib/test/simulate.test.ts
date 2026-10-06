import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { before, test } from 'node:test';
import { MeshTxBuilder, type Data, type UTxO } from '@meshsdk/core';
import {
  Transaction, TxCBOR, fromBuilderToPlutusData, normalizePlutusScript,
  resolvePlutusScriptAddress, resolveScriptRef, serializeAddress, toScriptRef,
} from '@meshsdk/core-cst';
import { enterpriseAddress, keyHash, signTx, verifyWitnesses } from '../src/keys.js';
import { ScriptFailure, type Utxo } from '../src/types.js';
import { simulate } from '../src/testing/simulate.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const data = (content: Data) => fromBuilderToPlutusData({ type: 'Mesh', content }).toCbor();
const seed = randomBytes(32);
const signer = hex(keyHash(seed));
const feeAddress = enterpriseAddress(seed);
const payees = [1, 2, 3, 4].map(n => n.toString(16).padStart(2, '0').repeat(28));
const payoutAddresses = payees.map(pubKeyHash => serializeAddress({ pubKeyHash }, 1));
const blueprint = JSON.parse(await readFile(new URL('./fixtures/stub.plutus.json', import.meta.url), 'utf8'));
const validator = blueprint.validators.find((v: { title: string }) => v.title === 'stub.stub.spend')!;
const script = { code: normalizePlutusScript(validator.compiledCode, 'DoubleCBOR'), version: 'V3' as const };
const scriptSize = normalizePlutusScript(script.code, 'SingleCBOR').length / 2;
const poolAddress = resolvePlutusScriptAddress(script, 1);
const nft = 'ab'.repeat(28) + '504f4f4c';
const state = (counter: number) => ({ alternative: 0, fields: [counter, payees] });
const assets = (lovelace: number, pool = false) => [
  { unit: 'lovelace', quantity: String(lovelace) },
  ...(pool ? [{ unit: nft, quantity: '1' }] : []),
];
const utxo = (byte: string, address: string, lovelace: number, extra: Partial<UTxO['output']> = {}): UTxO => ({
  input: { txHash: byte.repeat(32), outputIndex: 0 },
  output: { address, amount: assets(lovelace), ...extra },
});
const pool = utxo('80', poolAddress, 100000000, { amount: assets(100000000, true), plutusData: data(state(0)) });
const feeBefore = utxo('10', feeAddress, 20000000);
const feeAfter = utxo('f0', feeAddress, 20000000);
const collateral = utxo('20', feeAddress, 5000000);
const referenceScript = utxo('30', feeAddress, 20000000, { scriptRef: resolveScriptRef(script) });
const config = utxo('40', feeAddress, 3000000, { plutusData: data(0) });
const asp = utxo('50', feeAddress, 3000000, { plutusData: data(1) });
const placeholder = { mem: 16000000, steps: 9000000000 };

function chainUtxo(u: UTxO): Utxo {
  return {
    ref: { txId: u.input.txHash, index: u.input.outputIndex },
    address: u.output.address,
    value: {
      lovelace: BigInt(u.output.amount.find(a => a.unit === 'lovelace')!.quantity),
      assets: Object.fromEntries(u.output.amount.filter(a => a.unit !== 'lovelace').map(a => [a.unit, BigInt(a.quantity)])),
    },
    inlineDatum: u.output.plutusData ?? null,
    datumHash: u.output.dataHash ?? null,
    scriptRef: u.output.scriptRef ? { hash: validator.hash, cbor: u.output.scriptRef, size: scriptSize } : null,
  };
}

const resolved = (fee = feeBefore) => [pool, fee, collateral, referenceScript, config, asp].map(chainUtxo);
const buildDirectory = new URL('../build/', import.meta.url);
const temporaryDirectories = async () => (await readdir(buildDirectory)).filter(name => name.startsWith('simulate-')).sort();

function builder(): MeshTxBuilder {
  return new MeshTxBuilder({ params: {
    minFeeA: 44, minFeeB: 155381, priceMem: 0.0577, priceStep: 0.0000721,
    minFeeRefScriptCostPerByte: 15, coinsPerUtxoSize: 4310,
    maxTxExMem: '16500000', maxTxExSteps: '10000000000',
  } }).setNetwork('mainnet');
}

async function buildSettle(feeInput = feeBefore, badCounter = false): Promise<string> {
  const tx = builder()
    .spendingPlutusScriptV3()
    .txIn(pool.input.txHash, 0, pool.output.amount, poolAddress, 0)
    .spendingTxInReference(referenceScript.input.txHash, 0, String(scriptSize), validator.hash)
    .txInInlineDatumPresent()
    .txInRedeemerValue({ alternative: 0, fields: [0, '11'.repeat(192), signer, ''] }, 'Mesh', placeholder)
    .txIn(feeInput.input.txHash, 0, feeInput.output.amount, feeAddress, 0)
    .readOnlyTxInReference(config.input.txHash, 0, 0)
    .readOnlyTxInReference(asp.input.txHash, 0, 0)
    .txInCollateral(collateral.input.txHash, 0, collateral.output.amount, feeAddress)
    .requiredSignerHash(signer)
    .invalidHereafter(200000000)
    .changeAddress(feeAddress)
    .txOut(poolAddress, assets(86000000, true))
    .txOutInlineDatumValue(state(badCounter ? 2 : 1));
  payoutAddresses.forEach((address, index) => tx.txOut(address, assets((index + 2) * 1000000)));
  return tx.complete();
}

let valid: string;
let invalid: string;
before(async () => {
  assert.equal(toScriptRef(script).hash(), validator.hash);
  await mkdir(buildDirectory, { recursive: true });
  valid = await buildSettle();
  invalid = await buildSettle(feeBefore, true);
});

test('TX-05 (shape): a real stub spend reproduces the spike base units', async () => {
  assert.deepEqual(await simulate(valid, resolved()), [{ tag: 'spend', index: 1, mem: 235820n, steps: 91210662n }]);
});

test('TX-05 (shape): changing only the next counter throws ScriptFailure with diagnostics', async () => {
  await assert.rejects(simulate(invalid, resolved()), (error: unknown) => {
    assert.ok(error instanceof ScriptFailure);
    assert.match(error.message, /failed script execution/);
    assert.ok(error.traces.length > 0);
    assert.match(error.traces.join('\n'), /validator crashed|failed script execution/);
    return true;
  });
});

test('TX-05 (shape): every spent, reference, and collateral input must resolve', async t => {
  for (const missing of [pool, feeBefore, referenceScript, config, asp, collateral]) {
    await t.test(`missing ${missing.input.txHash.slice(0, 2)} input`, async () => {
      await assert.rejects(simulate(valid, resolved().filter(u => u.ref.txId !== missing.input.txHash)), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof ScriptFailure, false);
        assert.match(error.message, /Missing resolved input/);
        assert.match(error.message, new RegExp(missing.input.txHash));
        return true;
      });
    });
  }
});

test('TX-05 (shape): ledger spend index follows both fee input orders', async () => {
  for (const [fee, index] of [[feeBefore, 1], [feeAfter, 0]] as const) {
    const units = await simulate(await buildSettle(fee), resolved(fee));
    assert.equal(units.length, 1);
    assert.equal(units[0]!.tag, 'spend');
    assert.equal(units[0]!.index, index);
    assert.ok(units[0]!.mem > 0n && units[0]!.steps > 0n);
  }
});

test('TX-05 (shape): signing preserves script witnesses and reference evaluation', async () => {
  const signed = signTx(valid, [seed, randomBytes(32)]);
  assert.equal(verifyWitnesses(signed), true);
  assert.equal(Transaction.fromCbor(TxCBOR(signed)).witnessSet().redeemers()!.toCbor(),
    Transaction.fromCbor(TxCBOR(valid)).witnessSet().redeemers()!.toCbor());
  assert.deepEqual(await simulate(signed, resolved()), await simulate(valid, resolved()));
});

test('TX-05 (shape): two spends and one mint retain ledger tag and index order', async () => {
  // Compiled locally with Aiken 1.1.24 from: validator multi { else(_context: Data) { True } }
  // This generic evaluator fixture is separate from pool transactions, which cannot mint.
  const code = normalizePlutusScript('5101010023259800a518a4d136564004ae69', 'DoubleCBOR');
  const genericScript = { code, version: 'V3' as const };
  const address = resolvePlutusScriptAddress(genericScript, 1);
  const policy = toScriptRef(genericScript).hash();
  const spends = ['90', '80'].map(byte => utxo(byte, address, 10000000, { plutusData: data(0) }));
  const tx = builder();
  for (const input of spends) {
    tx.spendingPlutusScriptV3().txIn(input.input.txHash, 0, input.output.amount, address, 0)
      .txInScript(code).txInInlineDatumPresent().txInRedeemerValue(0, 'Mesh', { mem: 1000000, steps: 100000000 });
  }
  tx.txIn(feeBefore.input.txHash, 0, feeBefore.output.amount, feeAddress, 0)
    .mintPlutusScriptV3().mint('1', policy, '01').mintingScript(code)
    .mintRedeemerValue(0, 'Mesh', { mem: 1000000, steps: 100000000 })
    .txInCollateral(collateral.input.txHash, 0, collateral.output.amount, feeAddress)
    .txOut(feeAddress, [...assets(2000000), { unit: policy + '01', quantity: '1' }])
    .changeAddress(feeAddress);
  const cbor = await tx.complete();
  const units = await simulate(cbor, [...spends, feeBefore, collateral].map(chainUtxo));
  assert.deepEqual(units.map(({ tag, index }) => ({ tag, index })), [
    { tag: 'spend', index: 1 }, { tag: 'spend', index: 2 }, { tag: 'mint', index: 0 },
  ]);
  for (const entry of units) assert.ok(entry.mem > 0n && entry.steps > 0n);
});

test('TX-05 cleanup: concurrent success and script failure leave no temporary directories', async () => {
  const beforeDirectories = await temporaryDirectories();
  const results = await Promise.allSettled([
    simulate(valid, resolved()), simulate(valid, resolved()), simulate(invalid, resolved()),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.deepEqual(await temporaryDirectories(), beforeDirectories);
});

test('TX-05 (shape): preprod evaluates the stub with a finite validity bound', async () => {
  // The stub checks only that the upper bound is finite, so the existing bound works on both networks.
  assert.deepEqual(await simulate(valid, resolved(), 'preprod'), [
    { tag: 'spend', index: 1, mem: 235820n, steps: 91210662n },
  ]);
});
