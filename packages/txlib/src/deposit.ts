import { R } from '@zx402/crypto';
import { isAdaAsset, meshAsset } from './asset.js';
import { complete, newTxBuilder, readConfig, type ChainContext, type DepositUtxo, type Payer } from './context.js';
import { decodeDepositDatum, encodeDepositDatum, encodeDepositRedeemer } from './codec.js';
import { minimumLovelace } from './init.js';
import { utxoToMesh } from './providers/blockfrost.js';
import type { BuiltTx } from './types.js';

export async function buildDeposit(ctx: ChainContext, a: { payer: Payer; amount: bigint; precommitment: bigint; refundKeyHash: string }): Promise<BuiltTx> {
  if (typeof a.precommitment !== 'bigint' || a.precommitment <= 0n || a.precommitment >= R) {
    throw new RangeError('Deposit precommitment must satisfy 0 < precommitment < r');
  }
  const { datum: config } = await readConfig(ctx);
  if (typeof a.amount !== 'bigint' || a.amount < config.minDeposit || a.amount > config.maxDeposit) {
    throw new RangeError('Deposit amount must be within the config minimum and maximum');
  }
  if (config.depositsPaused) throw new Error('Deposits are paused');
  const { network, asset } = ctx.deployment;
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  const output = { address: ctx.deployment.scripts.deposit.address, amount: [meshAsset(asset, a.amount)],
    plutusData: encodeDepositDatum({ precommitment: a.precommitment, refund: a.refundKeyHash }) };
  if (!isAdaAsset(asset)) {
    // The datum and token both contribute to the ADA required by the ledger.
    const coinsPerByte = (await ctx.provider.getProtocolParameters()).coinsPerUtxoByte;
    output.amount.unshift({ unit: 'lovelace', quantity: String(minimumLovelace(output, coinsPerByte)) });
  }
  builder.txOut(output.address, output.amount).txOutInlineDatumValue(output.plutusData, 'CBOR');
  return complete({ provider: ctx.provider, network }, builder, { payer: a.payer });
}

export async function buildRefund(ctx: ChainContext, a: {
  payer: Payer; deposit: DepositUtxo; payTo: string; invalidHereafter?: number;
}): Promise<BuiltTx> {
  const { utxo, datum } = a.deposit;
  const actual = utxo.inlineDatum === null ? null : decodeDepositDatum(utxo.inlineDatum);
  if (utxo.address !== ctx.deployment.scripts.deposit.address || actual?.precommitment !== datum.precommitment
    || actual.refund !== datum.refund) {
    throw new Error('Refund requires a matching deposit address and inline datum');
  }
  const network = ctx.deployment.network;
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  const ref = ctx.deployment.refScripts.deposit;
  const script = ctx.deployment.scripts.deposit;
  const amount = utxoToMesh(utxo).output.amount;
  builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, amount, utxo.address, utxo.scriptRef?.size ?? 0)
    .spendingTxInReference(ref.txId, ref.index, String(script.size), script.hash).txInInlineDatumPresent()
    .txInRedeemerValue(encodeDepositRedeemer('Refund'), 'CBOR').requiredSignerHash(datum.refund)
    .txOut(a.payTo, amount);
  if (a.invalidHereafter !== undefined) builder.invalidHereafter(a.invalidHereafter);
  return complete({ provider: ctx.provider, network }, builder, { payer: a.payer, extraUtxos: [utxo] });
}
