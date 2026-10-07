import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toFacilitatorCardanoSigner, type FacilitatorCardanoSigner } from '@x402/cardano';
import { assetWireUnit, parseAssetWireUnit } from '@zx402/txlib';
import { ExactCardanoScheme as CardanoFacilitator } from '@x402/cardano/exact/facilitator';
import { ExactCardanoScheme as CardanoServer } from '@x402/cardano/exact/server';
import { x402Facilitator } from '@x402/core/facilitator';
import {
  x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient,
  type HTTPRequestContext, type HTTPResponseInstructions,
} from '@x402/core/server';

export interface SellerOptions {
  port: number;
  network: 'cardano:preprod' | 'cardano:mainnet';
  payTo: string;
  price?: { asset: string; amount: bigint };
  /** Keep existing ADA callers working while they move to price. */
  priceLovelace?: bigint;
  blockfrostProjectId: string;
  /** Optional chain adapter for offline tests or another chain provider. */
  facilitatorSigner?: FacilitatorCardanoSigner;
}

export async function startSeller(o: SellerOptions): Promise<{ url: string; close(): Promise<void> }> {
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('Invalid seller port');
  const price = o.price ?? { asset: 'lovelace', amount: o.priceLovelace };
  if (typeof price.amount !== 'bigint' || price.amount <= 0n) throw new Error('Price must be positive');
  // Normalize accepted hex before advertising the unit expected by the stock client.
  const asset = assetWireUnit(parseAssetWireUnit(price.asset));
  if (!o.payTo) throw new Error('Seller address is required');
  if (o.network !== 'cardano:preprod' && o.network !== 'cardano:mainnet') throw new Error('Invalid seller network');
  if (!o.facilitatorSigner && !o.blockfrostProjectId) throw new Error('Blockfrost project ID is required');
  const network = o.network.slice('cardano:'.length);
  const signer = o.facilitatorSigner ?? toFacilitatorCardanoSigner({
    network: o.network,
    provider: { blockfrost: {
      baseUrl: `https://cardano-${network}.blockfrost.io/api/v0`, projectId: o.blockfrostProjectId,
    } },
    awaitConfirmation: false,
  });
  const facilitator = new x402Facilitator().register(o.network, new CardanoFacilitator(signer));
  const localClient: FacilitatorClient = {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    async settle(payload, requirements) {
      const result = await facilitator.settle(payload, requirements);
      // A failed settlement is the one event an operator must see in the seller's log.
      if (!result.success) console.error(`settle failed: ${result.errorReason ?? 'no reason'}: ${result.errorMessage ?? 'no message'}`);
      return result;
    },
    async getSupported() {
      const supported = facilitator.getSupported();
      return { ...supported, kinds: supported.kinds.map(kind => ({ ...kind, network: o.network })) };
    },
  };
  const resource = new x402ResourceServer(localClient).register(o.network, new CardanoServer());
  const http = new x402HTTPResourceServer(resource, {
    'GET /weather': {
      accepts: { scheme: 'exact', network: o.network, payTo: o.payTo,
        price: { asset, amount: price.amount.toString() }, maxTimeoutSeconds: 300 },
      description: 'Demo weather', mimeType: 'application/json',
    },
  });
  await http.initialize();
  let url = '';
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? '/', url);
    const method = request.method ?? 'GET';
    if (method === 'GET' && requestUrl.pathname === '/health') {
      send(response, { status: 200, headers: {}, body: { ok: true } });
      return;
    }
    if (method !== 'GET' || requestUrl.pathname !== '/weather') {
      send(response, { status: 404, headers: {}, body: { error: 'Not found' } });
      return;
    }
    const header = (name: string): string | undefined => {
      const value = request.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    };
    const context: HTTPRequestContext = {
      path: requestUrl.pathname, method, paymentHeader: header('PAYMENT-SIGNATURE'),
      adapter: {
        getHeader: header, getMethod: () => method, getPath: () => requestUrl.pathname,
        getUrl: () => requestUrl.href, getAcceptHeader: () => header('accept') ?? '',
        getUserAgent: () => header('user-agent') ?? '',
      },
    };
    const result = await http.processHTTPRequest(context);
    if (result.type === 'payment-error') { send(response, result.response); return; }
    if (result.type !== 'payment-verified') throw new Error('Weather requires payment');
    const body = { weather: 'sunny', temperatureC: 28 };
    const settlement = await http.processSettlement(result.paymentPayload, result.paymentRequirements,
      result.declaredExtensions, { request: context, responseBody: Buffer.from(JSON.stringify(body)) });
    // Do not release the resource until the stock confirmation policy succeeds.
    if (!settlement.success) { send(response, settlement.response); return; }
    send(response, { status: 200, headers: settlement.headers, body });
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      // Provider errors can contain credentials. Keep server errors generic.
      send(response, { status: 500, headers: {}, body: { error: 'Payment processing failed' } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  url = `http://127.0.0.1:${address.port}`;
  return { url, close: () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }) };
}

function send(response: ServerResponse, result: HTTPResponseInstructions): void {
  response.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers });
  response.end(result.isHtml ? String(result.body ?? '') : JSON.stringify(result.body ?? {}));
}

async function main(): Promise<void> {
  const network = process.env.NETWORK ?? 'preprod';
  if (network !== 'preprod' && network !== 'mainnet') throw new Error('Invalid network');
  const asset = process.env.SELLER_PRICE_ASSET ?? 'lovelace';
  // The legacy variable names ADA, so it must never set a token price.
  const amount = process.env.SELLER_PRICE_AMOUNT ?? (asset === 'lovelace' ? process.env.SELLER_PRICE_LOVELACE : undefined) ?? '2000000';
  const server = await startSeller({
    port: Number(process.env.SELLER_PORT ?? '4021'), network: `cardano:${network}`,
    payTo: process.env.SELLER_ADDRESS ?? '', price: { asset, amount: BigInt(amount) },
    blockfrostProjectId: process.env.BLOCKFROST_PROJECT_ID ?? '',
  });
  console.log(`Seller listening at ${server.url}`);
  const stop = () => { void server.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { console.error('Seller could not start. Check its environment settings.'); process.exitCode = 1; });
}
