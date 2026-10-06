import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { blockfrostProvider } from '@zbase-cardano/txlib';
import type { Network, Provider } from '@zbase-cardano/txlib';
import { keySigner } from './key-signer.js';

interface PlainBuyerOptions {
  sellerUrl: string;
  seed: Uint8Array;
  provider: Provider;
  network: Network;
  maxLovelace?: bigint;
}

export async function payPlain(o: PlainBuyerOptions): Promise<{ status: number; body: string; transaction?: string }> {
  const network = `cardano:${o.network}` as const;
  const maxLovelace = o.maxLovelace ?? 2_000_000n;
  if (maxLovelace <= 0n) throw new Error('Buyer payment cap must be positive');
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network, client: new ExactCardanoScheme(keySigner(o)) }],
    // ADA is not a default USD asset. Opt in with an explicit atomic-unit cap.
    spendControls: { allowedAssets: [{ network, asset: 'lovelace', maxAmountPerPayment: maxLovelace.toString() }] },
  });
  const response = await paidFetch(new URL('/weather', o.sellerUrl), { redirect: 'error' });
  const header = response.headers.get('PAYMENT-RESPONSE');
  return { status: response.status, body: await response.text(),
    ...(header ? { transaction: decodePaymentResponseHeader(header).transaction } : {}) };
}

async function main(): Promise<void> {
  const network = process.env.NETWORK ?? 'preprod';
  if (network !== 'preprod' && network !== 'mainnet') throw new Error('Invalid network');
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  const seedHex = process.env.BUYER_SEED_HEX;
  if (!projectId || !seedHex || !/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error('Missing or invalid buyer settings');
  const seed = Buffer.from(seedHex, 'hex');
  try {
    const result = await payPlain({ sellerUrl: process.env.SELLER_URL ?? 'http://localhost:4021',
      network, seed, provider: blockfrostProvider(projectId, network),
      maxLovelace: BigInt(process.env.BUYER_MAX_LOVELACE ?? '2000000') });
    console.log(`Status: ${result.status}`);
    // Do not echo credentials even if a remote response happens to contain them.
    console.log(result.body.replaceAll(seedHex, '[redacted]').replaceAll(projectId, '[redacted]'));
    console.log(`Settlement transaction: ${result.transaction && /^[0-9a-f]{64}$/.test(result.transaction)
      ? result.transaction : 'none'}`);
    if (result.status !== 200 || !result.transaction) process.exitCode = 1;
  } finally {
    seed.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { console.error('Plain payment failed. Check funding and environment settings.'); process.exitCode = 1; });
}
