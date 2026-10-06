import { LargestFirstInputSelector, MeshTxBuilder, type Redeemer } from '@meshsdk/core';
import { bytesToHex, hexToBytes, type CardanoVk } from '@zbase-cardano/crypto';
import {
  decodeAspDatum, decodeConfigDatum, decodeDepositDatum, decodePoolDatum,
  type AspDatum, type ConfigDatum, type DepositDatum, type PoolDatum,
} from './codec.js';
import { utxoToMesh } from './providers/blockfrost.js';
import type { PoolScripts } from './scripts.js';
import { decodeTx } from './txview.js';
import { minFee, type BuiltTx, type Network, type Provider, type Utxo, type UtxoRef } from './types.js';

/** Everything needed to find and use a deployed pool, with JSON-safe verification keys. */
export interface Deployment {
  network: Network;
  poolId: string;
  seed: UtxoRef;
  asset: { policy: string; name: string };
  vkeys: { spend: CardanoVkHex; insert: CardanoVkHex; ragequit: CardanoVkHex };
  scripts: PoolScripts;
  refScripts: { pool: UtxoRef; deposit: UtxoRef; config: UtxoRef; asp: UtxoRef };
  initTx: string;
}
export interface CardanoVkHex { alpha: string; beta: string; gamma: string; delta: string; ic: string[] }
export function vkToHex(vk: CardanoVk): CardanoVkHex {
  return { alpha: bytesToHex(vk.alpha), beta: bytesToHex(vk.beta), gamma: bytesToHex(vk.gamma), delta: bytesToHex(vk.delta), ic: vk.ic.map(bytesToHex) };
}
export function vkFromHex(vk: CardanoVkHex): CardanoVk {
  return { alpha: hexToBytes(vk.alpha), beta: hexToBytes(vk.beta), gamma: hexToBytes(vk.gamma), delta: hexToBytes(vk.delta), ic: vk.ic.map(hexToBytes) };
}
export interface ChainContext { provider: Provider; deployment: Deployment }
/** Builders need only the payer's address and never sign. Supply UTXOs for unconfirmed change. */
export interface Payer { address: string; utxos?: Utxo[] }
/** Balance includes the ADA reserve and accrued fees, as in SPEC 6.5. */
export interface PoolState { utxo: Utxo; datum: PoolDatum; balance: bigint }
export interface DepositUtxo { utxo: Utxo; datum: DepositDatum }

async function readState<T>(ctx: ChainContext, name: 'pool' | 'config' | 'asp', decode: (cbor: string) => T): Promise<{ utxo: Utxo; datum: T }> {
  const unit = ctx.deployment.poolId + Buffer.from(name).toString('hex');
  const matches = (await ctx.provider.getUtxosAt(ctx.deployment.scripts[name].address)).filter(u => u.value.assets[unit] === 1n);
  if (matches.length !== 1) throw new Error(`Expected one ${name} NFT UTXO, found ${matches.length}`);
  const utxo = matches[0]!;
  if (utxo.inlineDatum === null) throw new Error(`Missing inline ${name} datum`);
  return { utxo, datum: decode(utxo.inlineDatum) };
}

export async function readPool(ctx: ChainContext): Promise<PoolState> {
  const state = await readState(ctx, 'pool', decodePoolDatum);
  const { policy, name } = ctx.deployment.asset;
  return { ...state, balance: policy === '' && name === '' ? state.utxo.value.lovelace : state.utxo.value.assets[policy + name] ?? 0n };
}
export function readConfig(ctx: ChainContext): Promise<{ utxo: Utxo; datum: ConfigDatum }> {
  return readState(ctx, 'config', decodeConfigDatum);
}
export function readAsp(ctx: ChainContext): Promise<{ utxo: Utxo; datum: AspDatum }> {
  return readState(ctx, 'asp', decodeAspDatum);
}
export async function readDeposits(ctx: ChainContext): Promise<DepositUtxo[]> {
  const deposits: DepositUtxo[] = [];
  for (const utxo of await ctx.provider.getUtxosAt(ctx.deployment.scripts.deposit.address)) {
    if (utxo.inlineDatum === null) continue;
    try { deposits.push({ utxo, datum: decodeDepositDatum(utxo.inlineDatum) }); }
    catch { /* Anyone can send malformed outputs to the deposit address. */ }
  }
  return deposits;
}

type BuilderContext = { provider: Provider; network: Network };
export async function newTxBuilder(ctx: BuilderContext): Promise<MeshTxBuilder> {
  const p = await ctx.provider.getProtocolParameters();
  // Mesh's default selector is random, which changes transaction IDs between runs.
  // Mesh stores custom cost models in its network field; a network name would replace them.
  return new MeshTxBuilder({ selector: new LargestFirstInputSelector(), params: {
    minFeeA: Number(p.minFeeA), minFeeB: Number(p.minFeeB), priceMem: p.priceMem, priceStep: p.priceStep,
    maxTxSize: p.maxTxSize, maxTxExMem: String(p.maxTxExMem), maxTxExSteps: String(p.maxTxExSteps),
    coinsPerUtxoSize: Number(p.coinsPerUtxoByte), minFeeRefScriptCostPerByte: p.refScriptCostPerByte,
    collateralPercent: p.collateralPercent, maxCollateralInputs: p.maxCollateralInputs,
  } }).setCostModels([p.costModels.PlutusV1, p.costModels.PlutusV2, p.costModels.PlutusV3]);
}

const refKey = (ref: UtxoRef): string => `${ref.txId}#${ref.index}`;

/** Balance once, evaluate real scripts, and reserve fees for all required key witnesses. */
export async function complete(ctx: BuilderContext, builder: MeshTxBuilder, a: { payer: Payer; extraUtxos?: Utxo[] }): Promise<BuiltTx> {
  const p = await ctx.provider.getProtocolParameters();
  const payerUtxos = a.payer.utxos ?? await ctx.provider.getUtxosAt(a.payer.address);
  // Flush queued inputs and outputs before inspecting the public builder body.
  builder.completeSync();
  const body = builder.meshTxBuilderBody;
  const scripted = body.inputs.some(i => i.type === 'Script') || body.mints.some(m => m.type === 'Plutus');
  const references = new Set(body.referenceInputs.map(r => `${r.txHash}#${r.txIndex}`));
  const available = payerUtxos.filter(u => u.address === a.payer.address && u.scriptRef === null
    && u.inlineDatum === null && u.datumHash === null && !references.has(refKey(u.ref)));
  if (scripted) {
    const collateral = available.filter(u => Object.keys(u.value.assets).length === 0 && u.value.lovelace >= 5_000_000n)
      .sort((a, b) => a.value.lovelace < b.value.lovelace ? -1 : a.value.lovelace > b.value.lovelace ? 1 : refKey(a.ref).localeCompare(refKey(b.ref)))[0];
    if (!collateral) throw new Error('Payer needs an ADA-only collateral UTXO with at least 5 ADA');
    builder.txInCollateral(collateral.ref.txId, collateral.ref.index, utxoToMesh(collateral).output.amount, collateral.address);
  }
  const requestedOutputs = body.outputs.length;
  builder.changeAddress(a.payer.address).selectUtxosFrom(available.sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref))).map(utxoToMesh));
  const draft = await builder.complete();
  const view = decodeTx(draft);
  const additional = [...new Map([...payerUtxos, ...(a.extraUtxos ?? [])].map(u => [refKey(u.ref), u])).values()];
  const measured = scripted ? await ctx.provider.evaluate(draft, additional) : [];
  if (measured.length !== view.redeemers.length || new Set(measured.map(u => `${u.tag}:${u.index}`)).size !== measured.length) {
    throw new Error('Provider returned an unexpected redeemer set');
  }
  for (const units of measured) {
    if (!view.redeemers.some(r => r.tag === units.tag && r.index === units.index) || units.mem < 0n || units.steps < 0n) {
      throw new Error('Provider returned invalid execution units');
    }
    const mem = (units.mem * 110n + 99n) / 100n;
    const steps = (units.steps * 110n + 99n) / 100n;
    if (mem > p.maxTxExMem || steps > p.maxTxExSteps) throw new Error('Execution units exceed transaction limits');
    const targets: Redeemer[] = [];
    if (units.tag === 'spend') {
      const input = body.inputs[units.index];
      if (input?.type === 'Script' && input.scriptTxIn.redeemer) targets.push(input.scriptTxIn.redeemer);
    } else if (units.tag === 'mint') {
      const policies = [...new Set(body.mints.map(m => m.policyId))].sort();
      for (const mint of body.mints) if (mint.policyId === policies[units.index] && mint.redeemer) targets.push(mint.redeemer);
    }
    if (targets.length === 0) throw new Error(`Unsupported redeemer ${units.tag}:${units.index}`);
    for (const target of targets) target.exUnits = { mem: Number(mem), steps: Number(steps) };
  }
  const resolved = new Map((await ctx.provider.getUtxos([...view.inputs, ...view.referenceInputs])).map(u => [refKey(u.ref), u]));
  for (const utxo of additional) resolved.set(refKey(utxo.ref), utxo);
  let refScriptBytes = 0;
  for (const ref of [...view.inputs, ...view.referenceInputs]) {
    const utxo = resolved.get(refKey(ref));
    if (!utxo) throw new Error(`Missing input ${refKey(ref)} while calculating fees`);
    refScriptBytes += utxo.scriptRef?.size ?? 0;
  }
  // Updating only change preserves output indexes and the evaluated input order.
  const change = body.outputs.slice(requestedOutputs).find(o => o.address === a.payer.address);
  let cbor = builder.completeSync();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = decodeTx(cbor);
    const signedSize = builder.serializeMockTx().length / 2;
    if (signedSize > p.maxTxSize) throw new Error('Transaction exceeds the maximum signed size');
    if (current.redeemers.reduce((sum, r) => sum + r.mem, 0n) > p.maxTxExMem
      || current.redeemers.reduce((sum, r) => sum + r.steps, 0n) > p.maxTxExSteps) throw new Error('Execution units exceed transaction limits');
    const fee = minFee(p, { size: signedSize, exUnits: current.redeemers, refScriptBytes });
    if (fee === current.fee || (change === undefined && current.fee >= fee)) {
      return { cbor, txId: current.txId, fee: current.fee, size: current.size,
        exUnits: current.redeemers.map(({ tag, index, mem, steps }) => ({ tag, index, mem, steps })) };
    }
    const coin = change?.amount.find(asset => asset.unit === 'lovelace');
    if (!coin) throw new Error('Payer needs another fee input to cover the final fee');
    const value = BigInt(coin.quantity) + current.fee - fee;
    if (value < 0n) throw new Error('Payer change cannot cover the final fee');
    coin.quantity = String(value);
    if (value < builder.calculateMinLovelaceForOutput(change!)) throw new Error('Payer change falls below minimum lovelace');
    builder.setFee(String(fee));
    cbor = builder.completeSync();
  }
  throw new Error('Transaction fee did not converge');
}
