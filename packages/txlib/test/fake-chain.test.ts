import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { MeshTxBuilder, type Data } from '@meshsdk/core';
import {
  CborSet, Certificate, CertificateType, Ed25519KeyHashHex, ExUnits, Hash, Hash28ByteBase16, Redeemers, RewardAccount, Slot,
  Transaction, TransactionOutput, TxCBOR, VkeyWitness, fromBuilderToPlutusData, normalizePlutusScript,
  resolvePlutusScriptAddress, serializeAddress, toScriptRef,
} from '@meshsdk/core-cst';
import { enterpriseAddress, keyHash, signTx } from '../src/keys.js';
import { MAINNET_PARAMETERS, PREPROD_PARAMETERS, ScriptFailure, slotToTime, type Utxo } from '../src/types.js';
import { decodeTx, outputsOf } from '../src/txview.js';
import { FakeChain, LedgerError, type LedgerRule } from '../src/testing/fake-chain.js';

const seed = randomBytes(32);
const address = enterpriseAddress(seed);
const signer = Buffer.from(keyHash(seed)).toString('hex');
const recipient = enterpriseAddress(randomBytes(32));
const data = (content: Data) => fromBuilderToPlutusData({ type: 'Mesh', content }).toCbor();
const amount = (u: Utxo) => [
  { unit: 'lovelace', quantity: String(u.value.lovelace) },
  ...Object.entries(u.value.assets).map(([unit, quantity]) => ({ unit, quantity: String(quantity) })),
];
const coins = (quantity: number) => [{ unit: 'lovelace', quantity: String(quantity) }];
const utxo = (byte: string, lovelace = 20000000n, extra: Partial<Utxo> = {}): Utxo => ({
  ref: { txId: byte.repeat(32), index: 0 }, address, value: { lovelace, assets: {} },
  inlineDatum: null, datumHash: null, scriptRef: null, ...extra,
});
const input = utxo('10');
const collateral = utxo('20', 5000000n);
const blueprint = JSON.parse(await readFile(new URL('./fixtures/stub.plutus.json', import.meta.url), 'utf8'));
const validator = blueprint.validators.find((v: { title: string }) => v.title === 'stub.stub.spend')!;
const script = { code: normalizePlutusScript(validator.compiledCode, 'DoubleCBOR'), version: 'V3' as const };
const scriptSize = normalizePlutusScript(script.code, 'SingleCBOR').length / 2;
const poolAddress = resolvePlutusScriptAddress(script, 1);
const payees = [1, 2, 3, 4].map(n => n.toString(16).padStart(2, '0').repeat(28));
const state = (counter: number) => ({ alternative: 0, fields: [counter, payees] });
const nft = 'ab'.repeat(28) + '504f4f4c';
const pool = utxo('80', 100000000n, {
  address: poolAddress, value: { lovelace: 100000000n, assets: { [nft]: 1n } }, inlineDatum: data(state(0)),
});
const reference = utxo('30', 20000000n, {
  scriptRef: { hash: validator.hash, cbor: toScriptRef(script).toCbor(), size: scriptSize },
});
const config = utxo('40', 3000000n, { inlineDatum: data(0) });
const asp = utxo('50', 3000000n, { inlineDatum: data(1) });
const resolved = [input, collateral, pool, reference, config, asp];
const builder = () => new MeshTxBuilder({ params: {
  minFeeA: 44, minFeeB: 155381, priceMem: 0.0577, priceStep: 0.0000721,
  minFeeRefScriptCostPerByte: 15, coinsPerUtxoSize: 4310,
  maxTxExMem: '16500000', maxTxExSteps: '10000000000',
} }).setNetwork('mainnet');

function chain(utxos = resolved, parameters = MAINNET_PARAMETERS): FakeChain {
  const result = new FakeChain({ startSlot: 100, parameters });
  utxos.forEach(u => result.addUtxo(u));
  return result;
}

async function payment(source = input, destination = address): Promise<string> {
  return signTx(await builder().txIn(source.ref.txId, source.ref.index, amount(source), source.address, 0)
    .txOut(destination, [{ unit: 'lovelace', quantity: String(source.value.lovelace - 1000000n) }])
    .invalidBefore(100).invalidHereafter(200).setFee('1000000').changeAddress(address).completeSync(), [seed]);
}

async function settle(counter = 1, embedded = false): Promise<string> {
  const tx = builder().spendingPlutusScriptV3().txIn(pool.ref.txId, 0, amount(pool), poolAddress, 0);
  if (embedded) tx.txInScript(script.code);
  else tx.spendingTxInReference(reference.ref.txId, 0, String(scriptSize), validator.hash);
  tx.txInInlineDatumPresent()
    .txInRedeemerValue({ alternative: 0, fields: [0, '11'.repeat(192), signer, ''] }, 'Mesh', { mem: 1000000, steps: 200000000 })
    .txIn(input.ref.txId, 0, amount(input), address, 0)
    .readOnlyTxInReference(config.ref.txId, 0, 0).readOnlyTxInReference(asp.ref.txId, 0, 0)
    .txInCollateral(collateral.ref.txId, 0, amount(collateral), address)
    .requiredSignerHash(signer).invalidHereafter(200000000).changeAddress(address)
    .txOut(poolAddress, [...coins(86000000), { unit: nft, quantity: '1' }]).txOutInlineDatumValue(state(counter));
  payees.forEach((pubKeyHash, i) => tx.txOut(serializeAddress({ pubKeyHash }, 1), coins((i + 2) * 1000000)));
  return signTx(await tx.complete(), [seed]);
}

function edit(cbor: string, change: (tx: Pick<Transaction, 'body' | 'witnessSet'>) => void, resign = true): string {
  const tx = Transaction.fromCbor(TxCBOR(cbor));
  const body = tx.body();
  const witnesses = tx.witnessSet();
  // Mesh getters return copies. Keep each copy until its changes are complete.
  change({ body: () => body, witnessSet: () => witnesses });
  tx.setBody(body);
  if (resign) witnesses.setVkeys(CborSet.fromCore([], VkeyWitness.fromCore));
  tx.setWitnessSet(witnesses);
  return resign ? signTx(tx.toCbor(), [seed]) : tx.toCbor();
}

async function rejectsRule(c: FakeChain, cbor: string, rule: LedgerRule): Promise<void> {
  const before = c.allUtxos();
  await assert.rejects(c.submit(cbor), (error: unknown) => {
    assert.ok(error instanceof LedgerError, String(error));
    assert.equal(error.rule, rule);
    return true;
  });
  assert.deepEqual(c.allUtxos(), before);
  assert.equal(c.transaction(decodeTx(cbor).txId), undefined);
}

let plain: string;
let scripted: string;
before(async () => { plain = await payment(); scripted = await settle(); });

test('TX-09 (shape): payment enters mempool then confirms in a block', async () => {
  const c = chain();
  const id = await c.submit(plain);
  assert.deepEqual(c.transaction(id), { cbor: plain, block: null });
  assert.deepEqual(await c.getUtxos([input.ref]), [input]);
  const block = c.mineBlock();
  assert.equal(block.height, 1);
  assert.equal(block.slot, 120);
  assert.match(block.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(block.txIds, [id]);
  assert.deepEqual(await c.getUtxos([input.ref]), []);
  assert.deepEqual(await c.getUtxos([{ txId: id, index: 0 }]), outputsOf(decodeTx(plain)));
  assert.deepEqual(c.transaction(id), { cbor: plain, block });
});

test('TX-08 (rules): unsupported withdrawals and certificates fail before other rules', async t => {
  await chain().submit(plain);
  await t.test('withdrawals', async () => {
    const changed = edit(plain, tx => tx.body().setWithdrawals(new Map([
      [RewardAccount.fromCredential({ type: 0, hash: Hash28ByteBase16(signer) }, 1), 1n],
    ])));
    assert.equal(decodeTx(changed).hasWithdrawals, true);
    await rejectsRule(chain([]), changed, 'unsupported');
  });
  await t.test('certificates', async () => {
    // Use the SDK's core representation so no hand-written CBOR is needed.
    const certificates: ReturnType<Certificate['toCore']>[] = [
      { __typename: CertificateType.StakeRegistration, stakeCredential: { type: 0, hash: Hash28ByteBase16(signer) } },
    ];
    const changed = edit(plain, tx => tx.body().setCerts(CborSet.fromCore(certificates, Certificate.fromCore)));
    assert.equal(decodeTx(changed).hasCertificates, true);
    await rejectsRule(chain(), changed, 'unsupported');
  });
});

test('TX-09 (rules): missing_input includes spent, reference, and collateral inputs', async t => {
  await chain().submit(scripted);
  for (const missing of [input, reference, collateral]) {
    await t.test(missing.ref.txId.slice(0, 2), async () => {
      await rejectsRule(chain(resolved.filter(u => u !== missing)), scripted, 'missing_input');
    });
  }
});

test('TX-09 (rules): duplicate_input rejects repeated spent inputs', async () => {
  await chain().submit(plain);
  const changed = edit(plain, tx => {
    const inputs = tx.body().inputs();
    inputs.setValues([inputs.values()[0]!, inputs.values()[0]!]);
    tx.body().setInputs(inputs);
  });
  await rejectsRule(chain(), changed, 'duplicate_input');
});

test('TX-09 (rules): outside_validity_interval respects inclusive start and exclusive end', async () => {
  await chain().submit(plain);
  await rejectsRule(chain(), edit(plain, tx => tx.body().setValidityStartInterval(Slot(101))), 'outside_validity_interval');
  await rejectsRule(chain(), edit(plain, tx => tx.body().setTtl(Slot(100))), 'outside_validity_interval');
});

test('TX-09 (rules): tx_too_large uses the signed transaction size', async () => {
  await chain().submit(plain);
  await rejectsRule(chain(resolved, { ...MAINNET_PARAMETERS, maxTxSize: plain.length / 2 - 1 }), plain, 'tx_too_large');
});

test('TX-05 (rules): ex_units_exceeded caps total declared units', async () => {
  await chain().submit(scripted);
  await rejectsRule(chain(resolved, { ...MAINNET_PARAMETERS, maxTxExMem: 999999n }), scripted, 'ex_units_exceeded');
  await rejectsRule(chain(resolved, { ...MAINNET_PARAMETERS, maxTxExSteps: 199999999n }), scripted, 'ex_units_exceeded');
});

test('TX-09 (rules): value_not_conserved rejects a lovelace imbalance', async () => {
  await chain().submit(plain);
  await rejectsRule(chain(), edit(plain, tx => tx.body().setFee(tx.body().fee() + 1n)), 'value_not_conserved');
});

test('TX-05 (rules): value_not_conserved rejects a token imbalance', async () => {
  await chain().submit(scripted);
  const changed = edit(scripted, tx => {
    const outputs = tx.body().outputs();
    const value = outputs[0]!.amount();
    const assets = value.multiasset()!;
    assets.set([...assets.keys()][0]!, 2n);
    value.setMultiasset(assets);
    outputs[0] = TransactionOutput.fromCore(outputs[0]!.toCore());
    tx.body().setOutputs(outputs);
  });
  await rejectsRule(chain(), changed, 'value_not_conserved');
});

test('TX-09 (rules): min_utxo uses the encoded output size', async () => {
  await chain().submit(plain);
  const changed = edit(plain, tx => {
    const outputs = tx.body().outputs();
    tx.body().setFee(tx.body().fee() + outputs[0]!.amount().coin() - 1n);
    outputs[0]!.amount().setCoin(1n);
    outputs[0] = TransactionOutput.fromCore(outputs[0]!.toCore());
    tx.body().setOutputs(outputs);
  });
  await rejectsRule(chain(), changed, 'min_utxo');
});

test('TX-09 (rules): fee_too_small rejects a balanced transaction with zero fee', async () => {
  await chain().submit(plain);
  const changed = edit(plain, tx => {
    const outputs = tx.body().outputs();
    outputs[0]!.amount().setCoin(outputs[0]!.amount().coin() + tx.body().fee());
    outputs[0] = TransactionOutput.fromCore(outputs[0]!.toCore());
    tx.body().setFee(0n);
    tx.body().setOutputs(outputs);
  });
  await rejectsRule(chain(), changed, 'fee_too_small');
});

test('TX-09 (rules): bad_signature rejects a witness after a body change', async () => {
  await chain().submit(plain);
  const changed = edit(plain, tx => tx.body().setTtl(Slot(201)), false);
  await rejectsRule(chain(), changed, 'bad_signature');
});

test('TX-09 (rules): missing_signature rejects an unsigned key spend', async () => {
  await chain().submit(plain);
  const changed = edit(plain, tx => tx.witnessSet().setVkeys(CborSet.fromCore([], VkeyWitness.fromCore)), false);
  await rejectsRule(chain(), changed, 'missing_signature');
});

test('TX-05 (rules): missing_script rejects an absent reference script', async () => {
  await chain().submit(scripted);
  await rejectsRule(chain(resolved.map(u => u === reference ? { ...u, scriptRef: null } : u)), scripted, 'missing_script');
});

test('TX-05 (rules): missing_datum rejects a script input without datum', async () => {
  await chain().submit(scripted);
  await rejectsRule(chain(resolved.map(u => u === pool ? { ...u, inlineDatum: null } : u)), scripted, 'missing_datum');
});

test('TX-05 (rules): missing_redeemer rejects a script spend without its redeemer', async () => {
  await chain().submit(scripted);
  const changed = edit(scripted, tx => tx.witnessSet().setRedeemers(Redeemers.fromCore([])));
  await rejectsRule(chain(), changed, 'missing_redeemer');
});

test('TX-05 (rules): insufficient_collateral rejects collateral below the fee percentage', async () => {
  await chain().submit(scripted);
  await rejectsRule(chain(resolved.map(u => u === collateral ? { ...u, value: { lovelace: 1n, assets: {} } } : u)),
    scripted, 'insufficient_collateral');
});

test('TX-05 (rules): script_failure rejects changing only the next pool counter', async () => {
  await chain().submit(scripted);
  await rejectsRule(chain(), await settle(2), 'script_failure');
});

test('TX-05 (rules): ex_units_exceeded rejects less memory or CPU than execution needs', async () => {
  await chain().submit(scripted);
  for (const units of [new ExUnits(1n, 200000000n), new ExUnits(1000000n, 1n)]) {
    const changed = edit(scripted, tx => {
      const redeemers = tx.witnessSet().redeemers()!;
      redeemers.values()[0]!.setExUnits(units);
      redeemers.setValues([...redeemers.values()]);
      tx.witnessSet().setRedeemers(redeemers);
    });
    await rejectsRule(chain(), changed, 'ex_units_exceeded');
  }
});

test('TX-09 (chaining): spend a mempool output once and confirm in submit order', async () => {
  const c = chain();
  const first = await c.submit(plain);
  const child = await payment(outputsOf(decodeTx(plain))[0]!);
  const second = await c.submit(child);
  await assert.rejects(c.submit(child), (e: unknown) => e instanceof LedgerError && e.rule === 'missing_input');
  assert.deepEqual(await c.getUtxos([{ txId: first, index: 0 }]), []);
  assert.deepEqual(c.mineBlock().txIds, [first, second]);
  assert.deepEqual(await c.getUtxos([{ txId: first, index: 0 }]), []);
  assert.deepEqual(await c.getUtxos([{ txId: second, index: 0 }]), outputsOf(decodeTx(child)));
});

test('TX-05 (evaluate): returns real units and resolves additional parent outputs without submission', async () => {
  const c = chain(resolved.filter(u => u !== pool));
  await assert.rejects(c.evaluate(scripted), (e: unknown) => e instanceof LedgerError && e.rule === 'missing_input');
  const unsigned = edit(scripted, tx => tx.witnessSet().setVkeys(CborSet.fromCore([], VkeyWitness.fromCore)), false);
  assert.deepEqual(await c.evaluate(unsigned, [pool]), [{ tag: 'spend', index: 1, mem: 235820n, steps: 91210662n }]);
  assert.deepEqual(await c.getUtxos([pool.ref]), []);
  assert.equal(c.transaction(decodeTx(scripted).txId), undefined);
  await assert.rejects(c.evaluate(await settle(2), [pool]), ScriptFailure);
});

test('TX-09 (time): expiry drops a mempool transaction and its dependent children', async () => {
  const c = chain();
  const expiring = edit(plain, tx => tx.body().setTtl(Slot(121)));
  const first = await c.submit(expiring);
  const child = await payment(outputsOf(decodeTx(expiring))[0]!);
  const second = await c.submit(child);
  c.advanceSlots(21);
  assert.equal(c.transaction(first), undefined);
  assert.equal(c.transaction(second), undefined);
  assert.deepEqual(c.mineBlock().txIds, []);
  assert.deepEqual(await c.getUtxos([input.ref]), [input]);
  const tip = await c.getTip();
  assert.equal(tip.slot, 141);
  assert.equal(tip.time, slotToTime(141));
  assert.equal(tip.blockHash, c.blocks()[0]!.hash);
});

test('TX-09 (rollback): restore one or two blocks and permit resubmission', async () => {
  const c = chain();
  const start = c.allUtxos();
  const first = await c.submit(plain);
  const block1 = c.mineBlock();
  const afterFirst = c.allUtxos();
  const child = await payment(outputsOf(decodeTx(plain))[0]!);
  const second = await c.submit(child);
  c.mineBlock();
  c.rollback(1);
  assert.deepEqual(c.allUtxos(), afterFirst);
  assert.deepEqual(c.blocks(), [block1]);
  assert.equal(c.transaction(second), undefined);
  assert.equal((await c.getTip()).slot, 120);
  await c.submit(child);
  c.mineBlock();
  c.rollback(2);
  assert.deepEqual(c.allUtxos(), start);
  assert.deepEqual(c.blocks(), []);
  assert.equal(c.transaction(first), undefined);
  assert.equal((await c.getTip()).slot, 100);
  await c.submit(plain);
});

test('TX-09 (reads): confirmed reads omit unknown refs and protect chain state from mutation', async () => {
  const c = chain([input]);
  const id = await c.submit(plain);
  assert.deepEqual(await c.getUtxosAt(address), [input]);
  assert.deepEqual(await c.getUtxos([input.ref, { txId: id, index: 0 }, utxo('ff').ref]), [input]);
  const returned = await c.getUtxosAt(address);
  returned[0]!.value.lovelace = 0n;
  assert.equal((await c.getUtxos([input.ref]))[0]!.value.lovelace, 20000000n);
  c.mineBlock();
  assert.deepEqual(await c.getUtxosAt(address), outputsOf(decodeTx(plain)));
});

test('TX-09 (history): list confirmed spends and receipts, paginate, preserve exact CBOR, and roll back', async () => {
  const c = chain([input]);
  const first = await c.submit(plain);
  const child = await payment(outputsOf(decodeTx(plain))[0]!, recipient);
  const second = await c.submit(child);
  assert.deepEqual(await c.getTransactionsAt(address), []);
  await assert.rejects(c.getTransactionCbor(first));
  c.mineBlock();
  assert.deepEqual(await c.getTransactionsAt(address), [
    { txId: first, blockHeight: 1, indexInBlock: 0 }, { txId: second, blockHeight: 1, indexInBlock: 1 },
  ]);
  assert.deepEqual(await c.getTransactionsAt(address, first), [{ txId: second, blockHeight: 1, indexInBlock: 1 }]);
  assert.deepEqual(await c.getTransactionsAt(recipient), [{ txId: second, blockHeight: 1, indexInBlock: 1 }]);
  assert.equal(await c.getTransactionCbor(second), child);
  assert.deepEqual(await c.getTransactionsAt(address, second), []);
  await assert.rejects(c.getTransactionsAt(address, 'ff'.repeat(32)));
  c.rollback(1);
  assert.deepEqual(await c.getTransactionsAt(address), []);
  await assert.rejects(c.getTransactionCbor(second));
});

test('TX-05 (shape): witness scripts resolve and successful spends preserve collateral and references', async () => {
  const c = chain();
  const cbor = await settle(1, true);
  await c.submit(cbor);
  c.mineBlock();
  assert.deepEqual(await c.getUtxos([collateral.ref, reference.ref]), [collateral, reference]);
});

test('TX-09 (network): preprod uses its parameter and clock defaults', async () => {
  const c = new FakeChain({ network: 'preprod', startSlot: 100 });
  assert.deepEqual(await c.getProtocolParameters(), PREPROD_PARAMETERS);
  assert.equal((await c.getTip()).time, slotToTime(100, 'preprod'));
  const { ref: unused, ...withoutRef } = input;
  const ref = c.addUtxo(withoutRef);
  assert.match(ref.txId, /^[0-9a-f]{64}$/);
  assert.deepEqual((await c.getUtxos([ref]))[0]!.value, input.value);
});

test('TX-09 (setup): addUtxo cannot overwrite a confirmed input reserved by the mempool', async () => {
  const c = chain([input]);
  await c.submit(plain);
  assert.throws(() => c.addUtxo({ ...input, value: { lovelace: 1n, assets: {} } }), /already exists/);
  assert.deepEqual(await c.getUtxos([input.ref]), [input]);
});

test('TX-09 (chaining): concurrent double spends reserve an input only once', async () => {
  const c = chain([input]);
  const results = await Promise.allSettled([c.submit(plain), c.submit(plain)]);
  assert.equal(results[0]!.status, 'fulfilled');
  assert.equal(results[1]!.status, 'rejected');
  if (results[1]!.status === 'rejected') {
    assert.ok(results[1]!.reason instanceof LedgerError);
    assert.equal(results[1]!.reason.rule, 'missing_input');
  }
  assert.equal(c.mineBlock().txIds.length, 1);
});

// This always-true V3 fixture is also used in simulate.test.ts for non-pool policies.
const generic = { code: normalizePlutusScript('5101010023259800a518a4d136564004ae69', 'DoubleCBOR'), version: 'V3' as const };
const genericPolicy = toScriptRef(generic).hash();

async function mint(): Promise<string> {
  return signTx(await builder().txIn(input.ref.txId, 0, amount(input), address, 0)
    .mintPlutusScriptV3().mint('2', genericPolicy, '01').mintingScript(generic.code)
    .mintRedeemerValue(0, 'Mesh', { mem: 1000000, steps: 200000000 })
    .txInCollateral(collateral.ref.txId, 0, amount(collateral), address)
    .changeAddress(address).complete(), [seed]);
}

test('TX-08 (generic mint): conserve minted tokens and require the policy script and mint redeemer', async () => {
  const cbor = await mint();
  const c = chain();
  const id = await c.submit(cbor);
  c.mineBlock();
  assert.equal((await c.getUtxos([{ txId: id, index: 0 }]))[0]!.value.assets[genericPolicy + '01'], 2n);
  const noRedeemer = edit(cbor, tx => tx.witnessSet().setRedeemers(Redeemers.fromCore([])));
  await rejectsRule(chain(), noRedeemer, 'missing_redeemer');
  const noScript = edit(cbor, tx => {
    const scripts = tx.witnessSet().plutusV3Scripts()!;
    scripts.setValues([]);
    tx.witnessSet().setPlutusV3Scripts(scripts);
  });
  await rejectsRule(chain(), noScript, 'missing_script');
});

test('TX-05 (datums): resolve a hashed datum from the witness set and reject a missing witness datum', async () => {
  const datum = fromBuilderToPlutusData({ type: 'Mesh', content: 42 });
  const source = utxo('90', 10000000n, {
    address: resolvePlutusScriptAddress(generic, 1), datumHash: datum.hash(),
  });
  const cbor = signTx(await builder().spendingPlutusScriptV3()
    .txIn(source.ref.txId, 0, amount(source), source.address, 0).txInScript(generic.code)
    .txInDatumValue(42).txInRedeemerValue(0, 'Mesh', { mem: 1000000, steps: 200000000 })
    .txInCollateral(collateral.ref.txId, 0, amount(collateral), address)
    .changeAddress(address).complete(), [seed]);
  await chain([source, collateral]).submit(cbor);
  const changed = edit(cbor, tx => {
    const datums = tx.witnessSet().plutusData()!;
    datums.setValues([]);
    tx.witnessSet().setPlutusData(datums);
  });
  await rejectsRule(chain([source, collateral]), changed, 'missing_datum');
});

test('TX-05 (rules): required signer and collateral owner each need their own key witness', async () => {
  await chain().submit(scripted);
  const other = randomBytes(32);
  const otherSigner = Buffer.from(keyHash(other)).toString('hex');
  const required = edit(scripted, tx => {
    const signers = tx.body().requiredSigners()!;
    signers.setValues([Hash.fromCore(Ed25519KeyHashHex(otherSigner))]);
    tx.body().setRequiredSigners(signers);
  });
  await rejectsRule(chain(), required, 'missing_signature');
  await rejectsRule(chain(resolved.map(u => u === collateral ? { ...u, address: enterpriseAddress(other) } : u)),
    scripted, 'missing_signature');
});

test('TX-05 (fees): reference bytes on spent inputs and reference inputs contribute to fees', async () => {
  await chain().submit(plain);
  const withScript = { ...input, scriptRef: reference.scriptRef };
  const expensive = { ...MAINNET_PARAMETERS, refScriptCostPerByte: 1000 };
  await rejectsRule(chain([withScript], expensive), plain, 'fee_too_small');
  const withReference = edit(plain, tx => tx.body().setReferenceInputs(
    Transaction.fromCbor(TxCBOR(scripted)).body().referenceInputs()!,
  ));
  await rejectsRule(chain(resolved, expensive), withReference, 'fee_too_small');
});

test('TX-09 (rules): accept the exact minimum output amount and reject one lovelace less', async () => {
  // A plain enterprise output with a uint32 coin occupies 37 bytes.
  const minimum = 849070n;
  const atMinimum = edit(plain, tx => {
    const outputs = tx.body().outputs();
    const output = outputs[0]!.toCore();
    output.value.coins = minimum;
    tx.body().setOutputs([TransactionOutput.fromCore(output)]);
    tx.body().setFee(input.value.lovelace - minimum);
  });
  assert.equal(Transaction.fromCbor(TxCBOR(atMinimum)).body().outputs()[0]!.toCbor().length / 2, 37);
  await chain().submit(atMinimum);
  const belowMinimum = edit(atMinimum, tx => {
    const output = tx.body().outputs()[0]!.toCore();
    output.value.coins = minimum - 1n;
    tx.body().setOutputs([TransactionOutput.fromCore(output)]);
    tx.body().setFee(tx.body().fee() + 1n);
  });
  await rejectsRule(chain(), belowMinimum, 'min_utxo');
});

test('TX-09 (time): mining drops transactions that expire at the new block slot', async () => {
  const c = chain([input]);
  const expiring = edit(plain, tx => tx.body().setTtl(Slot(120)));
  const id = await c.submit(expiring);
  assert.deepEqual(c.mineBlock().txIds, []);
  assert.equal(c.transaction(id), undefined);
  assert.deepEqual(await c.getUtxos([input.ref]), [input]);
});

test('TX-09 (rollback): rollback empties an unconfirmed child and history retains earlier blocks', async () => {
  const c = chain([input]);
  const first = await c.submit(plain);
  c.mineBlock();
  const child = await payment(outputsOf(decodeTx(plain))[0]!);
  const second = await c.submit(child);
  c.mineBlock();
  const third = await c.submit(await payment(outputsOf(decodeTx(child))[0]!));
  c.rollback(1);
  assert.equal(c.transaction(third), undefined);
  assert.equal(c.transaction(second), undefined);
  assert.deepEqual(await c.getTransactionsAt(address), [{ txId: first, blockHeight: 1, indexInBlock: 0 }]);
});
