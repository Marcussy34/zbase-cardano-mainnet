import { addressToBech32, type CardanoProof, type SettleIntent } from '@zx402/crypto';
import { addAssetAmount, isAdaAsset, meshAsset } from './asset.js';
import { encodePoolDatum, encodePoolRedeemer } from './codec.js';
import { complete, newTxBuilder, readAsp, readConfig, type ChainContext, type Payer, type PoolState } from './context.js';
import { minimumLovelace } from './init.js';
import { utxoToMesh } from './providers/blockfrost.js';
import { timeToSlot, type BuiltTx } from './types.js';

export async function buildSettle(ctx: ChainContext, a: {
  payer: Payer; pool: PoolState; proof: CardanoProof;
  nullifierHash: bigint; newCommitment: bigint; withdrawn: bigint; stateRoot: bigint;
  intent: SettleIntent; nullifierProof: string; newNullifierRoot: string;
  payoutLovelace?: bigint;
}): Promise<BuiltTx> {
  const { network, scripts, refScripts, asset } = ctx.deployment;
  const ada = isAdaAsset(asset);
  if (ada && a.payoutLovelace !== undefined && a.payoutLovelace !== 0n) {
    throw new Error('An ADA pool settle cannot set nonzero payoutLovelace');
  }
  if (!ada && (a.payoutLovelace === undefined || a.payoutLovelace <= 0n)) {
    throw new Error('A token pool settle needs payoutLovelace');
  }
  const deadline = Number(a.intent.validUntil);
  if (!Number.isSafeInteger(deadline) || deadline < 0) throw new RangeError('validUntil must be a safe nonnegative time');
  const upper = timeToSlot(deadline, network);
  const tip = await ctx.provider.getTip();
  if (upper <= tip.slot) throw new Error('Settle validUntil has expired');
  // The intent carries only a hash. No inline datum preimage is available through this interface.
  if (a.intent.payouts.some(p => p.datumHash !== null)) throw new Error('Payout datum hashes require an inline datum preimage');
  const [config, asp] = await Promise.all([readConfig(ctx), readAsp(ctx)]);
  const builder = await newTxBuilder({ provider: ctx.provider, network });
  const { utxo, datum } = a.pool;
  const paid = a.intent.payouts.reduce((sum, payout) => sum + payout.amount, 0n);
  const fee = paid * BigInt(config.datum.settleFeeBps) / 10_000n;
  const next = { ...datum, queue: [...datum.queue, a.newCommitment], nullifierRoot: a.newNullifierRoot, feesAccrued: datum.feesAccrued + fee };
  builder.spendingPlutusScriptV3().txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef?.size ?? 0)
    .spendingTxInReference(refScripts.pool.txId, refScripts.pool.index, String(scripts.pool.size), scripts.pool.hash)
    .txInInlineDatumPresent().txInRedeemerValue(encodePoolRedeemer({ kind: 'Settle', proof: a.proof,
      nullifierHash: a.nullifierHash, newCommitment: a.newCommitment, withdrawn: a.withdrawn, stateRoot: a.stateRoot,
      intent: a.intent, nullifierProof: a.nullifierProof }), 'CBOR')
    .readOnlyTxInReference(config.utxo.ref.txId, config.utxo.ref.index)
    .readOnlyTxInReference(asp.utxo.ref.txId, asp.utxo.ref.index)
    .txOut(utxo.address, utxoToMesh({ ...utxo, value: addAssetAmount(utxo.value, asset, -(a.withdrawn - fee)) }).output.amount)
    .txOutInlineDatumValue(encodePoolDatum(next), 'CBOR').invalidHereafter(upper);
  const coinsPerByte = ada ? 0n : (await ctx.provider.getProtocolParameters()).coinsPerUtxoByte;
  for (const payout of a.intent.payouts) {
    const address = addressToBech32(payout.address, network);
    const amount = ada ? [meshAsset(asset, payout.amount)]
      : [{ unit: 'lovelace', quantity: String(a.payoutLovelace) }, meshAsset(asset, payout.amount)];
    if (!ada) {
      // Each address and token amount can change the ledger's minimum output size.
      const minimum = minimumLovelace({ address, amount }, coinsPerByte);
      if (a.payoutLovelace! < minimum) throw new Error(`payoutLovelace is below the payout minimum lovelace (${minimum})`);
    }
    builder.txOut(address, amount);
  }
  if (a.intent.relayer !== null) builder.requiredSignerHash(Buffer.from(a.intent.relayer).toString('hex'));
  const references = await ctx.provider.getUtxos([refScripts.pool]);
  return complete({ provider: ctx.provider, network }, builder, { payer: a.payer, extraUtxos: [utxo, config.utxo, asp.utxo, ...references] });
}
