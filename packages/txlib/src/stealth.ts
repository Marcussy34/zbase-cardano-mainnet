import {
  Address, CborSet, Ed25519PublicKeyHex, Ed25519SignatureHex, Slot, Transaction,
  TransactionBody, TransactionId, TransactionInput, TransactionOutput, TransactionWitnessSet, Value, VkeyWitness,
} from '@meshsdk/core-cst';
import { enterpriseAddress, signTx, txId } from './keys.js';
import { minFee, type BuiltTx, type Network, type ProtocolParameters, type Provider, type Utxo, type UtxoRef } from './types.js';

type Context = { provider: Provider; network: Network };
type Payment = { payTo: string; price: bigint };
const maxCoin = (1n << 64n) - 1n;

function sellerOutput(network: Network, payment: Payment, parameters: ProtocolParameters): TransactionOutput {
  const address = Address.fromBech32(payment.payTo);
  if (address.getNetworkId() !== (network === 'mainnet' ? 1 : 0)) {
    throw new Error('Seller address belongs to another network');
  }
  if (!address.getProps().paymentPart) throw new Error('Seller must have a payment address');
  if (payment.price < 0n || payment.price > maxCoin) throw new RangeError('Price must fit an unsigned 64-bit lovelace amount');
  const output = new TransactionOutput(address, new Value(payment.price));
  const minimum = parameters.coinsPerUtxoByte * BigInt(160 + output.toCbor().length / 2);
  if (payment.price < minimum) throw new Error(`Price is below minimum lovelace for the seller output (${minimum})`);
  return output;
}

function transaction(ref: UtxoRef, output: TransactionOutput, fee: bigint, ttl: number): Transaction {
  const inputs = CborSet.fromCore([{ txId: TransactionId(ref.txId), index: ref.index }], TransactionInput.fromCore);
  return new Transaction(new TransactionBody(inputs, [output], fee, Slot(ttl)), new TransactionWitnessSet());
}

/** Quotes leg 2 so leg 1 can fund exactly price plus this fee, including a small size margin. */
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

/** Signs leg 2 with one input, one exact seller output, and all remaining lovelace as its fee. */
export async function buildStealthPayment(
  ctx: Context,
  a: Payment & { oneTimeUtxo: Utxo; oneTimeSeed: Uint8Array; validForSlots?: number },
): Promise<BuiltTx> {
  const input = a.oneTimeUtxo;
  if (Object.keys(input.value.assets).length !== 0) throw new Error('One-time UTXO must not contain any token');
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
  const output = sellerOutput(ctx.network, a, parameters);
  const fee = input.value.lovelace - a.price;
  if (fee < 0n) throw new Error('One-time UTXO cannot cover the price and minimum fee');
  const cbor = signTx(transaction(input.ref, output, fee, ttl).toCbor(), [a.oneTimeSeed]);
  const size = cbor.length / 2;
  const minimum = minFee(parameters, { size, exUnits: [], refScriptBytes: 0 });
  if (fee < minimum) throw new Error(`One-time UTXO fee is below the signed transaction minimum fee (${minimum})`);
  if (size > parameters.maxTxSize) throw new Error('Stealth payment exceeds the maximum transaction size');
  return { cbor, txId: txId(cbor), fee, size, exUnits: [] };
}
