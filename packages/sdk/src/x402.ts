import type { ClientCardanoSigner } from '@x402/cardano';
import { addressFromBech32, deriveOneTimeKey, NETWORKS } from '@zbase-cardano/crypto';
import { buildStealthPayment, enterpriseAddress, stealthFee, type ChainContext } from '@zbase-cardano/txlib';
import type { SettleReceipt } from './sdk.js';

interface Hooks {
  seed: Uint8Array;
  ctx: ChainContext;
  index(): number;
  advance(): Promise<void>;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  settle(a: { payouts: { address: string; amount: bigint }[] }): Promise<SettleReceipt>;
  poll<T>(check: () => Promise<T | undefined>, description: string): Promise<T>;
}

/** Each signer shares the SDK counter and operation queue, so callers cannot reuse a key. */
export function stealthSigner(h: Hooks): ClientCardanoSigner {
  const network = h.ctx.deployment.network;
  return {
    getAddress() {
      const key = deriveOneTimeKey(h.seed, h.index());
      try { return enterpriseAddress(key, network); }
      finally { key.fill(0); }
    },
    buildAndSignPaymentTransaction: input => h.exclusive(async () => {
      if (input.network !== `cardano:${network}`) throw new Error('Payment network does not match the deployment');
      if (input.asset !== 'lovelace') throw new Error('Only lovelace payments are supported');
      if (!/^[1-9][0-9]*$/.test(input.amount)) throw new Error('Payment amount must be a positive integer');
      if (!Number.isSafeInteger(input.maxTimeoutSeconds) || input.maxTimeoutSeconds <= 1) throw new Error('Payment timeout must exceed one second');
      if (input.extra?.assetTransferMethod !== undefined && input.extra.assetTransferMethod !== 'default') throw new Error('Only ordinary address payments are supported');
      addressFromBech32(input.payTo, network);
      const validForSlots = Math.min(240, Math.ceil(input.maxTimeoutSeconds * 1000 / NETWORKS[network].slotLength) - 1);
      const price = BigInt(input.amount);
      const context = { provider: h.ctx.provider, network };
      const fee = await stealthFee(context, { payTo: input.payTo, price });
      const index = h.index();
      const key = deriveOneTimeKey(h.seed, index);
      let funded = false;
      let advanced = false;
      try {
        const address = enterpriseAddress(key, network);
        const receipt = await h.settle({ payouts: [{ address, amount: price + fee }] });
        funded = true;
        const utxo = await h.poll(async () => (await h.ctx.provider.getUtxosAt(address)).find(u =>
          u.ref.txId === receipt.txHash && u.address === address && u.value.lovelace === price + fee
          && Object.keys(u.value.assets).length === 0 && u.inlineDatum === null && u.datumHash === null && u.scriptRef === null),
        `confirmed funding for one-time key index ${index}`);
        const built = await buildStealthPayment(context, { oneTimeUtxo: utxo, oneTimeSeed: key, payTo: input.payTo, price, validForSlots });
        await h.ctx.provider.evaluate(built.cbor);
        await h.advance();
        advanced = true;
        return { transaction: Buffer.from(built.cbor, 'hex').toString('base64'), nonce: `${utxo.ref.txId}#${utxo.ref.index}` };
      } catch (error) {
        if (!funded) throw error;
        // A failed leg 2 leaves funds at this key. Never fund the same address again.
        if (!advanced) await h.advance().catch(() => undefined);
        throw new Error(`Stealth payment failed after funding one-time key index ${index}; recover funds with that derivation index`, { cause: error });
      } finally { key.fill(0); }
    }),
  };
}
