import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { MeshTxBuilder, type UTxO, type IFetcher, type Data } from '@meshsdk/core';
import {
  Transaction, TxCBOR, CborSet, VkeyWitness, Ed25519PublicKeyHex, Ed25519SignatureHex,
  fromBuilderToPlutusData, fromTxUnspentOutput, TransactionInput, TransactionUnspentOutput,
  normalizePlutusScript, serializeAddress, resolvePlutusScriptAddress, resolveScriptRef,
  OfflineEvaluatorScalus, toScriptRef,
} from '@meshsdk/core-cst';
import { simulate, type Evaluation } from './sim.js';
import { Transaction as EvolutionTransaction } from '@evolution-sdk/evolution';

// TX-05 and TX-08 exercise real CBOR and the compiled script, without providers.
globalThis.fetch = async () => { throw new Error('Network access is forbidden in this spike'); };
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const data = (content: Data) => fromBuilderToPlutusData({ type: 'Mesh', content }).toCbor();
const seed = randomBytes(32);
const publicKey = ed25519.getPublicKey(seed);
const keyHash = hex(blake2b(publicKey, { dkLen: 28 }));
const feeAddress = serializeAddress({ pubKeyHash: keyHash }, 1);
const payees = [1, 2, 3, 4].map(n => n.toString(16).padStart(2, '0').repeat(28));
const payoutAddresses = payees.map(pubKeyHash => serializeAddress({ pubKeyHash }, 1));
const payoutAmounts = [2_000_000, 3_000_000, 4_000_000, 5_000_000];
const blueprint = JSON.parse(readFileSync(new URL('./stub/plutus.json', import.meta.url), 'utf8'));
const validator = blueprint.validators.find((v: { title: string }) => v.title === 'stub.stub.spend');
assert.ok(validator, 'Build the stub with npx aiken build before running the spike');
// Mesh's script reference decoder removes one CBOR layer. Preserve the ledger layer.
const script = { code: normalizePlutusScript(validator.compiledCode, 'DoubleCBOR'), version: 'V3' as const };
const scriptSize = normalizePlutusScript(script.code, 'SingleCBOR').length / 2;
assert.equal(toScriptRef(script).hash(), validator.hash, 'Reference script must retain the blueprint hash');
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
const pool = utxo('80', poolAddress, 100_000_000, { amount: assets(100_000_000, true), plutusData: data(state(0)) });
const feeBefore = utxo('10', feeAddress, 20_000_000);
const feeAfter = utxo('f0', feeAddress, 20_000_000);
const collateral = utxo('20', feeAddress, 5_000_000);
const referenceScript = utxo('30', feeAddress, 20_000_000, { scriptRef: resolveScriptRef(script) });
const config = utxo('40', feeAddress, 3_000_000, { plutusData: data(0) });
const asp = utxo('50', feeAddress, 3_000_000, { plutusData: data(1) });
const references = [referenceScript, config, asp];
const resolved = (fee = feeBefore, poolInput = pool) => [poolInput, fee, collateral, ...references];
const decode = (cbor: string) => Transaction.fromCbor(TxCBOR(cbor));
const placeholder = { mem: 16_000_000, steps: 9_000_000_000 };
type BuildOptions = {
  feeInput?: UTxO; poolInput?: UTxO; counter?: number; units?: { mem: number; steps: number };
  badCounter?: boolean; large?: boolean; fixedFee?: bigint; referenceSize?: number;
};
async function buildSettle(options: BuildOptions = {}): Promise<string> {
  const { feeInput = feeBefore, poolInput = pool, counter = 0, units = placeholder } = options;
  const builder = new MeshTxBuilder({ params: {
    minFeeA: 44, minFeeB: 155381, priceMem: 0.0577, priceStep: 0.0000721,
    minFeeRefScriptCostPerByte: 15, coinsPerUtxoSize: 4310,
    maxTxExMem: '16500000', maxTxExSteps: '10000000000',
  } });
  builder.setNetwork('mainnet')
    .spendingPlutusScriptV3()
    .txIn(poolInput.input.txHash, poolInput.input.outputIndex, poolInput.output.amount, poolInput.output.address, 0)
    .spendingTxInReference(referenceScript.input.txHash, 0, String(options.referenceSize ?? scriptSize), validator.hash)
    .txInInlineDatumPresent()
    .txInRedeemerValue({ alternative: 0, fields: [counter, '11'.repeat(192), keyHash, options.large ? '22'.repeat(760) : ''] }, 'Mesh', units)
    .txIn(feeInput.input.txHash, feeInput.input.outputIndex, feeInput.output.amount, feeInput.output.address, 0)
    .readOnlyTxInReference(config.input.txHash, 0, 0)
    .readOnlyTxInReference(asp.input.txHash, 0, 0)
    .txInCollateral(collateral.input.txHash, 0, collateral.output.amount, collateral.output.address)
    .requiredSignerHash(keyHash)
    .invalidHereafter(200_000_000)
    .changeAddress(feeAddress);
  const poolBalance = Number(poolInput.output.amount.find(a => a.unit === 'lovelace')!.quantity);
  builder.txOut(poolAddress, assets(poolBalance - 14_000_000, true))
    .txOutInlineDatumValue(state(counter + (options.badCounter ? 2 : 1)));
  payoutAddresses.forEach((address, index) => builder.txOut(address, assets(payoutAmounts[index]!)));
  if (options.fixedFee !== undefined) builder.setFee(String(options.fixedFee));
  const cbor = await builder.complete();
  return cbor;
}

function sign(cbor: string): string {
  const transaction = decode(cbor);
  const signature = ed25519.sign(Buffer.from(transaction.getId(), 'hex'), seed);
  const witnesses = transaction.witnessSet();
  witnesses.setVkeys(CborSet.fromCore([
    [Ed25519PublicKeyHex(hex(publicKey)), Ed25519SignatureHex(hex(signature))],
  ], VkeyWitness.fromCore));
  transaction.setWitnessSet(witnesses);
  return transaction.toCbor();
}

let passed = 0;
let failed = 0;
let concerns = 0;
async function probe(number: number, name: string, run: () => Promise<string> | string) {
  try {
    const detail = await run();
    passed += 1;
    console.log(`PASS ${number}: ${name}: ${detail}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${number}: ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let initial = '';
let measured: Evaluation[] = [];
await probe(1, 'Offline build (TX-05)', async () => {
  initial = await buildSettle();
  assert.ok(initial && /^[0-9a-f]+$/.test(initial), 'TX-05: offline Settle CBOR is missing');
  assert.equal(decode(initial).body().inputs().size(), 2);
  return 'Mesh built and balanced with no provider';
});

function assertShape(cbor: string) {
  const tx = decode(cbor);
  const body = tx.body();
  assert.equal(tx.witnessSet().plutusV1Scripts()?.size() ?? 0, 0);
  assert.equal(tx.witnessSet().plutusV3Scripts()?.size() ?? 0, 0);
  assert.equal(tx.witnessSet().plutusV2Scripts()?.size() ?? 0, 0);
  assert.equal(body.referenceInputs()?.size(), 3);
  assert.deepEqual(body.referenceInputs()?.values().map(r => r.transactionId()), references.map(r => r.input.txHash));
  assert.equal(body.collateral()?.values()[0]?.transactionId(), collateral.input.txHash);
  assert.equal(body.ttl(), 200_000_000);
  assert.deepEqual(body.requiredSigners()?.toCore(), [keyHash]);
  assert.equal(body.outputs().length, 6);
  assert.equal(body.outputs()[0]!.address().toBech32(), poolAddress);
  assert.equal(body.outputs()[0]!.amount().coin(), 86_000_000n);
  assert.equal(body.outputs()[0]!.datum()?.asInlineData()?.toCbor(), data(state(1)));
  assert.equal(body.outputs()[0]!.amount().multiasset()?.get(nft as never), 1n);
  payoutAddresses.forEach((address, i) => {
    assert.equal(body.outputs()[i + 1]!.address().toBech32(), address);
    assert.equal(body.outputs()[i + 1]!.amount().coin(), BigInt(payoutAmounts[i]!));
    assert.equal(body.outputs()[i + 1]!.datum(), undefined);
    assert.equal(body.outputs()[i + 1]!.scriptRef(), undefined);
  });
  assert.equal(body.outputs().at(-1)!.address().toBech32(), feeAddress);
  assert.equal(body.mint()?.size ?? 0, 0);
  assert.equal(body.withdrawals()?.size ?? 0, 0);
  assert.equal(body.certs()?.size() ?? 0, 0);
  const totalOut = body.outputs().reduce((sum, o) => sum + o.amount().coin(), 0n);
  assert.equal(totalOut + body.fee(), 120_000_000n);
  return `ordered outputs and reference script verified; collateral return=${body.collateralReturn()?.amount().coin() ?? 'absent'}`;
}
await probe(2, 'Shape (TX-05, TX-08)', () => assertShape(initial));

await probe(3, 'Input order and redeemer index (TX-05)', async () => {
  for (const [feeInput, index] of [[feeBefore, 1], [feeAfter, 0]] as const) {
    const cbor = await buildSettle({ feeInput });
    const tx = decode(cbor);
    const redeemer = tx.witnessSet().redeemers()!.values()[0]!;
    assert.equal(redeemer.index(), BigInt(index));
    assert.equal(tx.body().inputs().values()[index]!.transactionId(), pool.input.txHash);
    const ids = tx.body().inputs().values().map(i => i.transactionId());
    assert.deepEqual(ids, [...ids].sort());
    assert.equal(simulate(cbor, resolved(feeInput))[0]!.index, index);
  }
  return 'fee before: spend index 1; fee after: spend index 0; both evaluate';
});

const noFetcher = new Proxy({} as IFetcher, { get: () => () => { throw new Error('Unexpected UTXO fetch'); } });
const scalus = new OfflineEvaluatorScalus(noFetcher, 'mainnet', { zeroTime: 1596059091000, zeroSlot: 4492800, slotLength: 1000 });
await probe(4, 'Offline evaluation (TX-05)', async () => {
  measured = simulate(initial, resolved());
  const meshUnits = await scalus.evaluateTx(initial, resolved());
  assert.equal(meshUnits[0]!.index, measured[0]!.index);
  assert.equal(meshUnits[0]!.budget.mem, measured[0]!.budget.mem);
  // Keep both measurements visible. A matching success result does not imply equal costs.
  const delta = meshUnits[0]!.budget.steps - measured[0]!.budget.steps;
  if (delta !== 0) concerns += 1;
  const bad = await buildSettle({ badCounter: true });
  assert.throws(() => simulate(bad, resolved()), /failed script execution/);
  await assert.rejects(() => scalus.evaluateTx(bad, resolved()));
  // Evolution has an evaluator interface, but this install has no independent local evaluator.
  // Its CBOR works with the same external Aiken evaluator for both success and failure.
  const evolutionRoundtrip = (cbor: string) => EvolutionTransaction.toCBORHex(EvolutionTransaction.fromCBORHex(cbor));
  assert.deepEqual(simulate(evolutionRoundtrip(initial), resolved()), measured);
  assert.throws(() => simulate(evolutionRoundtrip(bad), resolved()), /failed script execution/);
  return `Aiken=${JSON.stringify(measured)}; Scalus CPU delta=${delta}; wrong counter fails both`;
});

function minimumFee(cbor: string, referenceBytes = scriptSize): bigint {
  const tx = decode(cbor);
  let executionNumerator = 0n;
  for (const r of tx.witnessSet().redeemers()?.values() ?? []) {
    executionNumerator += r.exUnits().mem() * 577_000n + r.exUnits().steps() * 721n;
  }
  const execution = (executionNumerator + 9_999_999n) / 10_000_000n;
  // Reference bytes are charged once per referenced UTXO, in 25,600-byte tiers.
  let remaining = BigInt(referenceBytes);
  let priceNumerator = 15n;
  let priceDenominator = 1n;
  let referenceNumerator = 0n;
  let referenceDenominator = 1n;
  while (remaining > 0n) {
    const bytes = remaining > 25_600n ? 25_600n : remaining;
    referenceNumerator = referenceNumerator * priceDenominator + bytes * priceNumerator * referenceDenominator;
    referenceDenominator *= priceDenominator;
    remaining -= bytes;
    priceNumerator *= 6n;
    priceDenominator *= 5n;
  }
  const reference = (referenceNumerator + referenceDenominator - 1n) / referenceDenominator;
  return 155_381n + 44n * BigInt(cbor.length / 2) + execution + reference;
}

let budget = placeholder;
let finalCbor = '';
let signed = '';
await probe(5, 'Two-pass budget and fee (TX-05)', async () => {
  const meshUnits = await scalus.evaluateTx(initial, resolved());
  const aikenUnits = measured[0]!.budget;
  budget = {
    mem: Math.ceil(Math.max(aikenUnits.mem, meshUnits[0]!.budget.mem) * 110 / 100),
    steps: Math.ceil(Math.max(aikenUnits.steps, meshUnits[0]!.budget.steps) * 110 / 100),
  };
  finalCbor = await buildSettle({ units: budget });
  signed = sign(finalCbor);
  assertShape(signed);
  const minimum = minimumFee(signed);
  const fee = decode(signed).body().fee();
  assert.ok(fee >= minimum, `Builder fee ${fee} is below independent minimum ${minimum}`);
  const finalUnits = simulate(signed, resolved())[0]!.budget;
  assert.ok(finalUnits.mem <= budget.mem && finalUnits.steps <= budget.steps);
  const withoutReference = sign(await buildSettle({ units: budget, referenceSize: 0 }));
  assert.equal(fee - decode(withoutReference).body().fee(), BigInt(scriptSize * 15));
  const exactFee = sign(await buildSettle({ units: budget, fixedFee: minimum }));
  assert.equal(decode(exactFee).body().fee(), minimumFee(exactFee));
  simulate(exactFee, resolved());
  return `budget=${JSON.stringify(budget)}; builder fee=${fee}; independent minimum=${minimum}; reference fee=${scriptSize * 15}; setFee(minimum) also evaluates`;
});

await probe(6, 'Raw-key signing (TX-05)', () => {
  const tx = decode(signed);
  const witness = tx.witnessSet().vkeys()!.values()[0]!;
  const [vkey, signature] = witness.toCore();
  assert.ok(ed25519.verify(Buffer.from(signature, 'hex'), Buffer.from(tx.getId(), 'hex'), Buffer.from(vkey, 'hex')));
  assert.equal(hex(blake2b(Buffer.from(vkey, 'hex'), { dkLen: 28 })), keyHash);
  assert.match(feeAddress, /^addr1v/);
  assert.equal(tx.getId(), decode(finalCbor).getId());
  assert.equal(tx.witnessSet().vkeys()?.size(), 1);
  return '32-byte throwaway seed; verified body-hash witness; enterprise mainnet address';
});

await probe(7, 'Chaining (TX-05)', async () => {
  const first = decode(signed);
  const outputs = first.body().outputs().map((output, index) => fromTxUnspentOutput(
    new TransactionUnspentOutput(new TransactionInput(first.getId(), BigInt(index)), output),
  ));
  const poolInput = outputs[0]!;
  const feeInput = outputs.at(-1)!;
  const chained = sign(await buildSettle({ poolInput, feeInput, counter: 1, units: budget }));
  const aiken = simulate(chained, resolved(feeInput, poolInput));
  const mesh = await scalus.evaluateTx(chained, [collateral, ...references], [signed]);
  assert.equal(aiken[0]!.index, 0);
  assert.equal(mesh[0]!.index, 0);
  assert.ok(aiken[0]!.budget.mem <= budget.mem && aiken[0]!.budget.steps <= budget.steps);
  assert.ok(mesh[0]!.budget.mem <= budget.mem && mesh[0]!.budget.steps <= budget.steps);
  assert.equal(decode(chained).body().outputs()[0]!.datum()?.asInlineData()?.toCbor(), data(state(2)));
  assert.equal(decode(chained).body().inputs().values()[1]!.index(), 5n);
  return `unsubmitted pool output 0 and change output 5 evaluate; ${JSON.stringify(aiken[0]!.budget)}`;
});

await probe(8, 'CBOR stability (TX-05)', async () => {
  const parsed = decode(signed);
  const roundtrip = parsed.toCbor();
  assert.equal(roundtrip, signed);
  assert.equal(decode(roundtrip).getId(), parsed.getId());
  const rebuilt = Transaction.fromCore(parsed.toCore()).toCbor();
  const coreStable = rebuilt === signed;
  if (!coreStable) concerns += 1;
  const evolutionCbor = EvolutionTransaction.toCBORHex(EvolutionTransaction.fromCBORHex(signed));
  const evolutionIdStable = decode(evolutionCbor).getId() === parsed.getId();
  if (!evolutionIdStable) concerns += 1;
  // The same Aiken helper can evaluate Evolution's output without a network provider.
  const evolutionUnits = simulate(evolutionCbor, resolved());
  assert.deepEqual(evolutionUnits, measured);
  return `Mesh bytes/ID stable; fromCore stable=${coreStable}; Evolution default bytes stable=${evolutionCbor === signed}, ID stable=${evolutionIdStable}, Aiken evaluation passes`;
});

await probe(9, 'Sizes (TX-05)', async () => {
  const large = sign(await buildSettle({ units: budget, large: true }));
  assertShape(large);
  const units = simulate(large, resolved())[0]!.budget;
  assert.ok(units.mem <= budget.mem && units.steps <= budget.steps);
  assert.ok(large.length / 2 < 16_384);
  assert.ok(decode(large).body().fee() >= minimumFee(large));
  return `signed base=${signed.length / 2} bytes; proof192+nullifier760=${large.length / 2} bytes; script=${scriptSize} bytes; ${JSON.stringify(units)}`;
});

await probe(10, 'x402 signer contract (read only)', () =>
  'reviewed @x402/cardano 2.28.0 definitions; base64 signed CBOR plus txHashHex#index nonce; see REPORT.md',
);

seed.fill(0);
console.log(`Checks: ${passed} passed, ${failed} failed, ${concerns} concerns`);
process.exitCode = failed ? 1 : 0;
