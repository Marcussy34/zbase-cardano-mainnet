import type { ClientCardanoSigner } from '@x402/cardano';
import { getUtxoMinLovelace, MeshTxBuilder } from '@meshsdk/core';
import { Address, Transaction, TxCBOR } from '@meshsdk/core-cst';
import { enterpriseAddress, signTx } from '@zbase-cardano/txlib';
import type { Network, Provider } from '@zbase-cardano/txlib';

export function keySigner(o: { seed: Uint8Array; provider: Provider; network: Network }): ClientCardanoSigner {
  const address = enterpriseAddress(o.seed, o.network);
  return {
    getAddress: () => address,
    async buildAndSignPaymentTransaction(input) {
      if (input.network !== `cardano:${o.network}`) throw new Error('Payment network does not match the key');
      if (input.asset !== 'lovelace') throw new Error('Only lovelace payments are supported');
      if (!/^[1-9][0-9]*$/.test(input.amount)) throw new Error('Amount must be a positive integer');
      if (!Number.isSafeInteger(input.maxTimeoutSeconds) || input.maxTimeoutSeconds <= 0) {
        throw new Error('Payment timeout must be a positive integer');
      }
      if (input.extra?.assetTransferMethod !== undefined && input.extra.assetTransferMethod !== 'default') {
        throw new Error('Only ordinary address payments are supported');
      }
      if (Address.fromBech32(input.payTo).getNetworkId() !== (o.network === 'mainnet' ? 1 : 0)) {
        throw new Error('Recipient network does not match the key');
      }
      const [utxos, parameters, tip] = await Promise.all([
        o.provider.getUtxosAt(address), o.provider.getProtocolParameters(), o.provider.getTip(),
      ]);
      const payment = { address: input.payTo, amount: [{ unit: 'lovelace', quantity: input.amount }] };
      if (BigInt(input.amount) < getUtxoMinLovelace(payment, Number(parameters.coinsPerUtxoByte))) {
        throw new Error('Payment amount is below minimum ADA');
      }
      const ttl = tip.slot + input.maxTimeoutSeconds;
      if (!Number.isSafeInteger(ttl) || tip.slot < 0) throw new Error('Invalid payment expiry slot');
      const builder = new MeshTxBuilder({ params: {
        minFeeA: Number(parameters.minFeeA), minFeeB: Number(parameters.minFeeB),
        coinsPerUtxoSize: Number(parameters.coinsPerUtxoByte), maxTxSize: parameters.maxTxSize,
      } });
      // Supply complete input values so Mesh never needs its own chain connection.
      const available = utxos.filter(u => u.address === address && u.scriptRef === null).map(u => ({
        input: { txHash: u.ref.txId, outputIndex: u.ref.index },
        output: { address, amount: [
          { unit: 'lovelace', quantity: u.value.lovelace.toString() },
          ...Object.entries(u.value.assets).map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
        ] },
      }));
      const unsigned = await builder.setNetwork(o.network)
        .txOut(payment.address, payment.amount)
        .changeAddress(address).invalidHereafter(ttl).selectUtxosFrom(available).complete();
      const tx = Transaction.fromCbor(TxCBOR(unsigned));
      // Keep the quote exact even if the builder changes output balancing behavior.
      if (tx.body().outputs()[0]?.amount().coin() !== BigInt(input.amount)) {
        throw new Error('Builder changed the payment amount');
      }
      const first = tx.body().inputs().values()[0];
      if (!first) throw new Error('Payment has no funding input');
      const signed = signTx(unsigned, [o.seed]);
      return {
        transaction: Buffer.from(signed, 'hex').toString('base64'),
        nonce: `${first.transactionId()}#${first.index()}`,
      };
    },
  };
}
