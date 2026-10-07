import { setInConwayEra } from '@cardano-sdk/core';
import {
  Address, AssetId, CborSet, Ed25519PublicKeyHex, Ed25519SignatureHex, Slot, Transaction,
  TransactionBody, TransactionId, TransactionInput, TransactionOutput, TransactionWitnessSet, Value, VkeyWitness,
} from '@meshsdk/core-cst';
import { assetUnit, isAdaAsset, meshAsset, type AssetClass } from './asset.js';
import { minimumLovelace } from './init.js';
import { enterpriseAddress, signTx, txId } from './keys.js';
import { minFee, type BuiltTx, type Network, type ProtocolParameters, type Provider, type Utxo, type UtxoRef } from './types.js';

type Context = { provider: Provider; network: Network };
type Payment = { payTo: string; price: bigint; asset?: AssetClass };
const maxCoin = (1n << 64n) - 1n;

function sellerOutput(network: Network, payment: Payment, parameters: ProtocolParameters, checkMinimum = true): TransactionOutput {
  const address = Address.fromBech32(payment.payTo);
  if (address.getNetworkId() !== (network === 'mainnet' ? 1 : 0)) {
    throw new Error('Seller address belongs to another network');
  }
  if (!address.getProps().paymentPart) throw new Error('Seller must have a payment address');
  if (payment.price < 0n || payment.price > maxCoin) throw new RangeError('Price must fit an unsigned 64-bit lovelace amount');
  if (payment.asset !== undefined && !isAdaAsset(payment.asset)) {
    const minimum = minimumLovelace({ address: payment.payTo, amount: [meshAsset(payment.asset, payment.price)] }, parameters.coinsPerUtxoByte);
    return new TransactionOutput(address, new Value(minimum, new Map([[AssetId(assetUnit(payment.asset)), payment.price]])));
  }
  const output = new TransactionOutput(address, new Value(payment.price));
  const minimum = parameters.coinsPerUtxoByte * BigInt(160 + output.toCbor().length / 2);
  if (checkMinimum && payment.price < minimum) throw new Error(`Price is below minimum lovelace for the seller output (${minimum})`);
  return output;
}

/** Measure the seller output before the caller chooses how much ADA to fund. */
export async function sellerMinimumLovelace(ctx: Context, payment: Payment): Promise<bigint> {
  const parameters = await ctx.provider.getProtocolParameters();
  const output = sellerOutput(ctx.network, payment, parameters, false);
  return parameters.coinsPerUtxoByte * BigInt(160 + output.toCbor().length / 2);
}

function transaction(ref: UtxoRef, output: TransactionOutput, fee: bigint, ttl: number): Transaction {
  // Stock facilitators re-encode leg 2 with the Conway set tag on its inputs before they submit it. The serializer
  // writes that tag only while this flag is on, and Mesh turns it on only once a transaction builder exists in the
  // process. A payment built before any builder ran must carry the tag too, or the re-encoding breaks its signature.
  setInConwayEra(true);
  const inputs = CborSet.fromCore([{ txId: TransactionId(ref.txId), index: ref.index }], TransactionInput.fromCore);
  return new Transaction(new TransactionBody(inputs, [output], fee, Slot(ttl)), new TransactionWitnessSet());
}

/** Quotes the leg 2 network fee with a small size margin for leg 1 funding. */
export async function stealthFee(ctx: Context, a: Payment): Promise<bigint> {
  const parameters = await ctx.provider.getProtocolParameters();
  const output = sellerOutput(ctx.network, a, parameters);
  const tx = transaction({ txId: '00'.repeat(32), index: 0 }, output, 0n, 0);
  const witnesses = tx.witnessSet();
  // Witness sizes are fixed. Estimate with public placeholders without deriving any signing key.
  witnesses.setVkeys(CborSet.fromCore([
    [Ed25519PublicKeyHex('00'.repeat(32)), Ed25519SignatureHex('00'.repeat(64))],
  ], VkeyWitness.fromCore));
  tx.setWitnessSet(witnesses);
  // Index, expiry, and fee can each grow from one to nine CBOR bytes.
  // Preserve the Spec's 2,000 lovelace buffer unless live fees need more for those 24 bytes.
  const sizeMargin = parameters.minFeeA * 24n;
  const margin = sizeMargin > 2000n ? sizeMargin : 2000n;
  return minFee(parameters, { size: tx.toCbor().length / 2, exUnits: [], refScriptBytes: 0 }) + margin;
}

/** Signs one input and one seller output, forwarding surplus ADA only for token payments. */
export async function buildStealthPayment(
  ctx: Context,
  a: Payment & { oneTimeUtxo: Utxo; oneTimeSeed: Uint8Array; validForSlots?: number },
): Promise<BuiltTx> {
  const input = a.oneTimeUtxo;
  const token = a.asset !== undefined && !isAdaAsset(a.asset);
  if (token) {
    if (Object.keys(input.value.assets).length !== 1 || input.value.assets[assetUnit(a.asset!)] !== a.price) {
      throw new Error('One-time UTXO must hold exactly the price of the pool asset and no other token');
    }
  } else if (Object.keys(input.value.assets).length !== 0) throw new Error('One-time UTXO must not contain any token');
  if (input.inlineDatum !== null || input.datumHash !== null) throw new Error('One-time UTXO must not contain a datum');
  if (input.scriptRef !== null) throw new Error('One-time UTXO must not contain a reference script');
  if (input.address !== enterpriseAddress(a.oneTimeSeed, ctx.network)) {
    throw new Error('One-time UTXO address does not match the one-time key on this network');
  }
  if (!/^[0-9a-f]{64}$/.test(input.ref.txId)
    || !Number.isSafeInteger(input.ref.index) || input.ref.index < 0) {
    throw new Error('Invalid one-time UTXO reference');
  }
  if (input.value.lovelace < 0n || input.value.lovelace > maxCoin) {
    throw new RangeError('One-time UTXO lovelace must fit an unsigned 64-bit amount');
  }
  const duration = a.validForSlots ?? 240;
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new RangeError('validForSlots must be a positive safe integer');
  const [parameters, tip] = await Promise.all([ctx.provider.getProtocolParameters(), ctx.provider.getTip()]);
  const ttl = tip.slot + duration;
  if (!Number.isSafeInteger(tip.slot) || tip.slot < 0 || !Number.isSafeInteger(ttl)) {
    throw new RangeError('Invalid provider tip or expiry slot');
  }
  let output = sellerOutput(ctx.network, a, parameters);
  const fee = token ? await stealthFee(ctx, a) : input.value.lovelace - a.price;
  if (token) {
    const lovelace = input.value.lovelace - fee;
    if (lovelace < output.amount().coin()) throw new Error('One-time UTXO cannot cover the seller minimum lovelace and the fee');
    // A fresh output avoids cached CBOR after changing the amount used for the fee quote.
    output = new TransactionOutput(output.address(), new Value(lovelace, output.amount().multiasset()));
  }
  if (fee < 0n) throw new Error('One-time UTXO cannot cover the price and minimum fee');
  const cbor = signTx(transaction(input.ref, output, fee, ttl).toCbor(), [a.oneTimeSeed]);
  const size = cbor.length / 2;
  const minimum = minFee(parameters, { size, exUnits: [], refScriptBytes: 0 });
  if (fee < minimum) throw new Error(`One-time UTXO fee is below the signed transaction minimum fee (${minimum})`);
  if (size > parameters.maxTxSize) throw new Error('Stealth payment exceeds the maximum transaction size');
  return { cbor, txId: txId(cbor), fee, size, exUnits: [] };
}
