import type { CardanoProof } from '@zx402/crypto';
import { addAssetAmount, isAdaAsset, meshAsset } from './asset.js';
import { encodePoolDatum, encodePoolRedeemer } from './codec.js';
import { complete, newTxBuilder, readConfig, type ChainContext, type Payer, type PoolState } from './context.js';
import { minimumLovelace } from './init.js';
import { utxoToMesh } from './providers/blockfrost.js';
import type { BuiltTx, UtxoRef } from './types.js';

export async function buildRagequit(ctx: ChainContext, a: {
  payer: Payer; pool: PoolState; proof: CardanoProof;
  nullifierHash: bigint; value: bigint; stateRoot: bigint;
  depositRef: UtxoRef; refundKeyHash: string; nullifierProof: string; newNullifierRoot: string;
  payTo: string; invalidHereafter?: number;
}): Promise<BuiltTx> {
  const { network, scripts, refScripts, asset } = ctx.deployment;
  const config = await readConfig(ctx);
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  const { utxo, datum } = a.pool;
  const output = { address: a.payTo, amount: [meshAsset(asset, a.value)] };
  if (!isAdaAsset(asset)) {
    // The payer funds the exit's minimum ADA so the pool reserve stays unchanged.
    const coinsPerByte = (await ctx.provider.getProtocolParameters()).coinsPerUtxoByte;
    output.amount.unshift({ unit: 'lovelace', quantity: String(minimumLovelace(output, coinsPerByte)) });
  }
  builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef?.size ?? 0)
    .spendingTxInReference(refScripts.pool.txId, refScripts.pool.index, String(scripts.pool.size), scripts.pool.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodePoolRedeemer({ kind: 'Ragequit', proof: a.proof,
      nullifierHash: a.nullifierHash, value: a.value, stateRoot: a.stateRoot, depositRef: a.depositRef,
      refund: a.refundKeyHash, nullifierProof: a.nullifierProof }), 'CBOR')
    .readOnlyTxInReference(config.utxo.ref.txId, config.utxo.ref.index)
    .requiredSignerHash(a.refundKeyHash)
    .txOut(utxo.address, utxoToMesh({ ...utxo, value: addAssetAmount(utxo.value, asset, -a.value) }).output.amount)
    .txOutInlineDatumValue(encodePoolDatum({ ...datum, nullifierRoot: a.newNullifierRoot }), 'CBOR')
    .txOut(output.address, output.amount);
  if (a.invalidHereafter !== undefined) builder.invalidHereafter(a.invalidHereafter);
  const references = await ctx.provider.getUtxos([refScripts.pool]);
  return complete({ provider: ctx.provider, network }, builder, { payer: a.payer, extraUtxos: [utxo, config.utxo, ...references] });
}
