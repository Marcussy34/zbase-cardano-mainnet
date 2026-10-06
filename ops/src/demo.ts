import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { IndexerClient, RelayerClient } from '@zbase-cardano/api';
import { createZbaseCardano, fileStore } from '@zbase-cardano/core';
import { shutdown, type CircuitArtifacts } from '@zbase-cardano/prover';
import { blockfrostProvider, type ChainContext, type Deployment } from '@zbase-cardano/txlib';
import { readSettings } from './env.js';
import { deploymentArtifacts, redactedLog } from './node.js';
import { roleSeed } from './roles.js';

export interface DemoOptions {
  ctx: ChainContext;
  indexerUrl: string; relayerUrl: string; sellerUrl: string;
  walletSeed: Uint8Array;
  agentSeed: Uint8Array;
  artifacts: { spend: CircuitArtifacts; ragequit: CircuitArtifacts };
  depositLovelace?: bigint;
  storePath?: string;
  exit?: boolean;
  poll?: { intervalMs?: number; timeoutMs?: number; onPoll?: () => void | Promise<void> };
  log?: (line: string) => void;
}
export interface DemoResult {
  depositTx: string; noteValue: bigint;
  paid: { status: number; body: string; settlementTx: string | null; leg1Tx: string; oneTimeAddress: string };
  exitTx: string | null;
  seconds: { toSpendable: number; payment: number; total: number };
}

export async function runDemo(o: DemoOptions): Promise<DemoResult> {
  const start = performance.now();
  const elapsed = (since: number) => (performance.now() - since) / 1000;
  const log = redactedLog(o.log ?? (() => {}), [o.walletSeed, o.agentSeed].map(seed => Buffer.from(seed).toString('hex')));
  if (o.storePath) await mkdir(dirname(o.storePath), { recursive: true });
  const indexer = new IndexerClient(o.indexerUrl);
  const sdk = createZbaseCardano({ seed: o.agentSeed, ctx: o.ctx, indexer,
    relayer: new RelayerClient(o.relayerUrl), artifacts: o.artifacts,
    ...(o.storePath ? { store: fileStore(o.storePath) } : {}), poll: o.poll });
  const deposit = await sdk.deposit({ amount: o.depositLovelace ?? 10_000_000n, walletSeed: o.walletSeed });
  log(`Deposit ${deposit.txId} submitted in ${elapsed(start).toFixed(3)} seconds`);
  const note = await sdk.waitForNote(deposit.prepared.noteId);
  if (note.value === null) throw new Error('Spendable deposit has no value');
  const toSpendable = elapsed(start);
  log(`Deposit ${deposit.txId} spendable: ${note.value} lovelace in ${toSpendable.toFixed(3)} seconds`);

  const paymentStart = performance.now();
  const network = `cardano:${o.ctx.deployment.network}` as const;
  const weather = new URL('/weather', o.sellerUrl);
  const challenge = await fetch(weather, { redirect: 'error' });
  const required = challenge.headers.get('PAYMENT-REQUIRED');
  await challenge.body?.cancel();
  if (challenge.status !== 402 || !required) throw new Error('Seller did not advertise an x402 price');
  const offer = decodePaymentRequiredHeader(required).accepts.find(a => a.scheme === 'exact'
    && a.network === network && a.asset === 'lovelace' && /^[1-9][0-9]*$/.test(a.amount));
  if (!offer) throw new Error('Seller did not offer a lovelace payment on this network');
  const signer = sdk.x402Signer({ mode: 'stealth' });
  let leg1Tx = '';
  let oneTimeAddress = '';
  const before = new Set(sdk.listNotes().map(n => n.id));
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network, client: new ExactCardanoScheme({
      getAddress: () => signer.getAddress(),
      async buildAndSignPaymentTransaction(input) {
        oneTimeAddress = signer.getAddress();
        const signed = await signer.buildAndSignPaymentTransaction(input);
        leg1Tx = signed.nonce.split('#')[0]!;
        log(`Private payment ${leg1Tx} confirmed in ${elapsed(paymentStart).toFixed(3)} seconds`);
        return signed;
      },
    }) }],
    // ADA requires an explicit atomic-unit allowance in the stock client.
    spendControls: { allowedAssets: [{ network, asset: 'lovelace', maxAmountPerPayment: offer.amount }] },
  });
  const response = await paidFetch(weather, { redirect: 'error' });
  const body = await response.text();
  const header = response.headers.get('PAYMENT-RESPONSE');
  const settlement = header ? decodePaymentResponseHeader(header) : null;
  const settlementTx = settlement?.transaction || null;
  const payment = elapsed(paymentStart);
  log(`Seller payment ${settlementTx ?? 'none'} returned HTTP ${response.status} in ${payment.toFixed(3)} seconds`);
  if (response.status !== 200 || !settlement?.success || !settlementTx || !leg1Tx) {
    throw new Error(`Seller payment failed with HTTP ${response.status}; leg 1 transaction ${leg1Tx || 'none'}`);
  }
  const change = sdk.listNotes().find(n => n.kind === 'change' && !before.has(n.id));
  let exitTx: string | null = null;
  if (change) {
    const changeStart = performance.now();
    await sdk.waitForNote(change.id);
    log(`Change from ${leg1Tx} spendable in ${elapsed(changeStart).toFixed(3)} seconds`);
    if (o.exit ?? true) {
      const exitStart = performance.now();
      exitTx = (await sdk.ragequit({ noteId: change.id, refundSeed: o.walletSeed })).txId;
      log(`Exit ${exitTx} submitted in ${elapsed(exitStart).toFixed(3)} seconds`);
      const deadline = Date.now() + (o.poll?.timeoutMs ?? 600_000);
      // Confirm the pool output before reporting final balances or starting another demo.
      for (;;) {
        await o.poll?.onPoll?.();
        if ((await o.ctx.provider.getUtxos([{ txId: exitTx, index: 0 }])).length > 0) break;
        if (Date.now() >= deadline) throw new Error(`Timed out confirming exit ${exitTx}`);
        await delay(Math.min(o.poll?.intervalMs ?? 3_000, Math.max(0, deadline - Date.now())));
      }
      log(`Exit ${exitTx} confirmed in ${elapsed(exitStart).toFixed(3)} seconds`);
    }
  }
  const total = elapsed(start);
  log(`Demo complete in ${total.toFixed(3)} seconds`);
  return { depositTx: deposit.txId, noteValue: note.value,
    paid: { status: response.status, body, settlementTx, leg1Tx, oneTimeAddress }, exitTx,
    seconds: { toSpendable, payment, total } };
}

async function main(): Promise<void> {
  const settings = readSettings();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const deployment = JSON.parse(await readFile(join(root, `deployments/${settings.network}.json`), 'utf8')) as Deployment;
  if (deployment.network !== settings.network) throw new Error('Deployment network does not match NETWORK');
  const keys = await deploymentArtifacts(deployment, root);
  const walletSeed = roleSeed(settings.operatorSeed, 'user');
  const agentSeed = roleSeed(settings.operatorSeed, 'agent');
  const log = redactedLog(console.log, [settings.blockfrostProjectId, ...[settings.operatorSeed, walletSeed, agentSeed]
    .map(seed => Buffer.from(seed).toString('hex'))]);
  try {
    if (settings.network === 'mainnet') log('CAUTION: this demo spends real ADA. Submitted transactions cannot be undone.');
    const result = await runDemo({ ctx: { provider: blockfrostProvider(settings.blockfrostProjectId, settings.network), deployment },
      indexerUrl: process.env.INDEXER_URL ?? 'http://127.0.0.1:4010',
      relayerUrl: process.env.RELAYER_URL ?? 'http://127.0.0.1:4011',
      sellerUrl: process.env.SELLER_URL ?? 'http://127.0.0.1:4021', walletSeed, agentSeed,
      artifacts: { spend: await keys.load('spend'), ragequit: await keys.load('ragequit') },
      storePath: join(root, `deployments/${settings.network}/demo-store.json`), log });
    log(result.paid.body);
  } finally {
    walletSeed.fill(0);
    agentSeed.fill(0);
    settings.operatorSeed.fill(0);
    await shutdown();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    redactedLog(console.error, [process.env.OPERATOR_SEED_HEX ?? '', process.env.BLOCKFROST_PROJECT_ID ?? ''])(
      error instanceof Error ? error.message : 'Demo failed');
    process.exitCode = 1;
  }
}
