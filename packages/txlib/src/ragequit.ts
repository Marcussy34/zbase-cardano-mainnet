import type { CardanoProof } from '@zbase-cardano/crypto';
import { encodePoolDatum, encodePoolRedeemer } from './codec.js';
import { complete, newTxBuilder, readConfig, type ChainContext, type Payer, type PoolState } from './context.js';
import { utxoToMesh } from './providers/blockfrost.js';
import type { BuiltTx, UtxoRef } from './types.js';

export async function buildRagequit(ctx: ChainContext, a: {
  payer: Payer; pool: PoolState; proof: CardanoProof;
  nullifierHash: bigint; value: bigint; stateRoot: bigint;
  depositRef: UtxoRef; refundKeyHash: string; nullifierProof: string; newNullifierRoot: string;
  payTo: string; invalidHereafter?: number;
}): Promise<BuiltTx> {
  const { network, scripts, refScripts, asset } = ctx.deployment;
  if (asset.policy !== '' || asset.name !== '') throw new Error('M0 exits support ADA only');
  const config = await readConfig(ctx);
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  const { utxo, datum } = a.pool;
  builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef?.size ?? 0)
    .spendingTxInReference(refScripts.pool.txId, refScripts.pool.index, String(scripts.pool.size), scripts.pool.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodePoolRedeemer({ kind: 'Ragequit', proof: a.proof,
      nullifierHash: a.nullifierHash, value: a.value, stateRoot: a.stateRoot, depositRef: a.depositRef,
      refund: a.refundKeyHash, nullifierProof: a.nullifierProof }), 'CBOR')
    .readOnlyTxInReference(config.utxo.ref.txId, config.utxo.ref.index)
    .requiredSignerHash(a.refundKeyHash)
    .txOut(utxo.address, utxoToMesh({ ...utxo, value: { ...utxo.value, lovelace: utxo.value.lovelace - a.value } }).output.amount)
    .txOutInlineDatumValue(encodePoolDatum({ ...datum, nullifierRoot: a.newNullifierRoot }), 'CBOR')
    .txOut(a.payTo, [{ unit: 'lovelace', quantity: String(a.value) }]);
  if (a.invalidHereafter !== undefined) builder.invalidHereafter(a.invalidHereafter);
  const references = await ctx.provider.getUtxos([refScripts.pool]);
  return complete({ provider: ctx.provider, network }, builder, { payer: a.payer, extraUtxos: [utxo, config.utxo, ...references] });
}
