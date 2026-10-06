import { assertCanonical } from '@zbase-cardano/crypto';
import { encodeAspDatum, encodeVoid } from './codec.js';
import { complete, newTxBuilder, readAsp, type ChainContext, type Payer } from './context.js';
import { utxoToMesh } from './providers/blockfrost.js';
import type { BuiltTx } from './types.js';

/** Recreates the ASP state with its existing operators and URI. Operators sign afterwards. */
export async function buildAspUpdate(ctx: ChainContext, a: { payer: Payer; root: bigint; signers: string[] }): Promise<BuiltTx> {
  assertCanonical(a.root, 'ASP root');
  const { network, scripts, refScripts } = ctx.deployment;
  const { utxo, datum } = await readAsp(ctx);
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef?.size ?? 0)
    .spendingTxInReference(refScripts.asp.txId, refScripts.asp.index, String(scripts.asp.size), scripts.asp.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodeVoid(), 'CBOR')
    .txOut(utxo.address, utxoToMesh(utxo).output.amount)
    .txOutInlineDatumValue(encodeAspDatum({ ...datum, root: a.root }), 'CBOR');
  for (const signer of new Set(a.signers)) builder.requiredSignerHash(signer);
  const references = await ctx.provider.getUtxos([refScripts.asp]);
  return complete({ provider: ctx.provider, network }, builder, { payer: a.payer, extraUtxos: [utxo, ...references] });
}
