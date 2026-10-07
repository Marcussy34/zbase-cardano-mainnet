import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { IndexerClient, RelayerClient } from '@zx402/api';
import { createZx402, fileStore, type NoteRecord } from '@zx402/core';
import { shutdown, type CircuitArtifacts } from '@zx402/prover';
import { assetWireUnit, blockfrostProvider, enterpriseAddress, type ChainContext, type Deployment } from '@zx402/txlib';
import { readSettings } from './env.js';
import { deploymentArtifacts, redactedLog } from './node.js';
import { roleSeed } from './roles.js';

export interface DemoOptions {
  ctx: ChainContext;
  indexerUrl: string; relayerUrl: string; sellerUrl: string;
  walletSeed: Uint8Array;
  agentSeed: Uint8Array;
  artifacts: { spend: CircuitArtifacts; ragequit: CircuitArtifacts };
  depositAmount?: bigint;
  /** Keep the old amount option for ADA callers only. */
  depositLovelace?: bigint;
  storePath?: string;
  /** Pay from a note that is already spendable when the store has one. A staged demo skips the deposit wait. */
  reuseNote?: boolean;
  exit?: boolean;
  poll?: { intervalMs?: number; timeoutMs?: number; onPoll?: () => void | Promise<void> };
  log?: (line: string) => void;
}
export interface DemoResult {
  depositTx: string | null; noteValue: bigint;
  paid: { status: number; body: string; settlementTx: string | null; leg1Tx: string; oneTimeAddress: string };
  exitTx: string | null;
  seconds: { toSpendable: number; payment: number; total: number };
}

/** Cardanoscan base URL for the deployment's network. */
export function explorerUrl(network: Deployment['network']): string {
  return network === 'mainnet' ? 'https://cardanoscan.io' : `https://${network}.cardanoscan.io`;
}

/** The lines that let an audience check on the explorer what the chain shows and what it does not. */
export function proofLines(deployment: Deployment, p: { depositTx: string | null; wallet: string; leg1Tx: string;
  oneTimeAddress: string; settlementTx: string | null; seller: string; exitTx: string | null }): string[] {
  const base = explorerUrl(deployment.network);
  // Hashes and addresses come from the chain and the seller; only their own alphabet reaches the terminal.
  const clean = (value: string, pattern: RegExp) => pattern.test(value) ? value : 'invalid';
  const tx = (hash: string) => `${base}/transaction/${clean(hash, /^[0-9a-f]{64}$/)}`;
  const addr = (address: string) => `${base}/address/${clean(address, /^[a-z0-9_]{20,120}$/)}`;
  p = { ...p, wallet: clean(p.wallet, /^[a-z0-9_]{20,120}$/), oneTimeAddress: clean(p.oneTimeAddress, /^[a-z0-9_]{20,120}$/),
    seller: clean(p.seller, /^[a-z0-9_]{20,120}$/) };
  const lines = ['', 'What the chain shows, on the explorer:',
    `  Pool            ${addr(deployment.scripts.pool.address)}`];
  if (p.depositTx) lines.push(`  Deposit         ${tx(p.depositTx)}`, `                  from the agent's wallet ${p.wallet}, in public like any deposit`);
  else lines.push(`  Agent's wallet  ${addr(p.wallet)}`, '                  funded the pool earlier; it does not appear below');
  lines.push(`  Private payment ${tx(p.leg1Tx)}`, `                  the pool pays one-time address ${p.oneTimeAddress} with a proof; no deposit is named`,
    `  One-time addr   ${addr(p.oneTimeAddress)}`);
  if (p.settlementTx) lines.push(`  Seller payment  ${tx(p.settlementTx)}`, `                  the one-time address pays the seller ${p.seller} through stock x402`);
  lines.push(`  Seller          ${addr(p.seller)}`);
  if (p.exitTx) lines.push(`  Exit            ${tx(p.exitTx)}`, `                  the change returns to the agent's wallet in public`);
  lines.push('Not on the chain: any link from the agent\'s wallet or its deposit to the one-time address or the seller.');
  return lines;
}

export async function runDemo(o: DemoOptions): Promise<DemoResult> {
  const start = performance.now();
  const elapsed = (since: number) => (performance.now() - since) / 1000;
  const unit = assetWireUnit(o.ctx.deployment.asset);
  const log = redactedLog(o.log ?? (() => {}), [o.walletSeed, o.agentSeed].map(seed => Buffer.from(seed).toString('hex')));
  if (o.storePath) await mkdir(dirname(o.storePath), { recursive: true });
  const indexer = new IndexerClient(o.indexerUrl);
  const relayer = new RelayerClient(o.relayerUrl);
  const sdk = createZx402({ seed: o.agentSeed, ctx: o.ctx, indexer, relayer, artifacts: o.artifacts,
    ...(o.storePath ? { store: fileStore(o.storePath) } : {}), poll: o.poll });
  const amount = o.depositAmount ?? (unit === 'lovelace' ? o.depositLovelace : undefined) ?? 10_000_000n;

  // The seller's price comes first, so a reused note can be checked against the price plus the fees.
  const network = `cardano:${o.ctx.deployment.network}` as const;
  const weather = new URL('/weather', o.sellerUrl);
  const challenge = await fetch(weather, { redirect: 'error' });
  const required = challenge.headers.get('PAYMENT-REQUIRED');
  await challenge.body?.cancel();
  if (challenge.status !== 402 || !required) throw new Error('Seller did not advertise an x402 price');
  const offer = decodePaymentRequiredHeader(required).accepts.find(a => a.scheme === 'exact'
    && a.network === network && a.asset === unit && /^[1-9][0-9]*$/.test(a.amount));
  if (!offer) throw new Error(`Seller did not offer a ${unit} payment on this network`);
  log(`Seller asks ${offer.amount} ${unit} for the weather`);

  let depositTx: string | null = null;
  let note: NoteRecord | undefined;
  if (o.reuseNote) {
    await sdk.sync();
    // One Settle spends one note, so a single note must cover the price plus the fees.
    const quote = await relayer.quote([{ address: offer.payTo, amount: BigInt(offer.amount), datumHash: null }]);
    note = sdk.listNotes()
      .filter(n => n.status === 'spendable' && !n.pending && n.value !== null && n.value >= quote.withdrawn)
      .sort((a, b) => a.value! < b.value! ? -1 : a.value! > b.value! ? 1 : 0)[0];
    log(note ? `Note ${note.id} in the pool covers the price plus fees ${quote.withdrawn - BigInt(offer.amount)} ${unit}; no deposit`
      : `No note in the pool covers ${quote.withdrawn} ${unit}; depositing`);
  }
  if (!note) {
    const deposit = await sdk.deposit({ amount, walletSeed: o.walletSeed });
    depositTx = deposit.txId;
    log(`Deposit ${depositTx} submitted in ${elapsed(start).toFixed(3)} seconds`);
    note = await sdk.waitForNote(deposit.prepared.noteId);
  }
  if (note.value === null) throw new Error('Spendable deposit has no value');
  const toSpendable = elapsed(start);
  log(`${depositTx ? `Deposit ${depositTx}` : `Note ${note.id}`} spendable: ${note.value} ${unit} in ${toSpendable.toFixed(3)} seconds`);

  const paymentStart = performance.now();
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
    // The stock client must explicitly allow the pool asset and quoted amount.
    spendControls: { allowedAssets: [{ network, asset: unit, maxAmountPerPayment: offer.amount }] },
  });
  const response = await paidFetch(weather, { redirect: 'error' });
  const body = await response.text();
  const header = response.headers.get('PAYMENT-RESPONSE');
  const settlement = header ? decodePaymentResponseHeader(header) : null;
  const settlementTx = settlement?.transaction || null;
  const payment = elapsed(paymentStart);
  log(`Seller payment ${settlementTx ?? 'none'} returned HTTP ${response.status} in ${payment.toFixed(3)} seconds`);
  if (response.status !== 200 || !settlement?.success || !settlementTx || !leg1Tx) {
    // The facilitator's reason tells a verify failure from a submit failure.
    const reason = settlement ? ` (${settlement.errorReason ?? 'no reason'}: ${settlement.errorMessage ?? 'no message'})` : '';
    throw new Error(`Seller payment failed with HTTP ${response.status}${reason}; leg 1 transaction ${leg1Tx || 'none'}`);
  }
  const change = sdk.listNotes().find(n => n.kind === 'change' && !before.has(n.id));
  let exitTx: string | null = null;
  if (change) {
    const changeStart = performance.now();
    await sdk.waitForNote(change.id);
    log(`Change from ${leg1Tx} spendable in ${elapsed(changeStart).toFixed(3)} seconds`);
    if (!(o.exit ?? true)) {
      log(`Change ${change.id} stays in the pool for the next payment`);
    } else {
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
  for (const line of proofLines(o.ctx.deployment, { depositTx, wallet: enterpriseAddress(o.walletSeed, o.ctx.deployment.network),
    leg1Tx, oneTimeAddress, settlementTx, seller: offer.payTo, exitTx })) log(line);
  return { depositTx, noteValue: note.value,
    paid: { status: response.status, body, settlementTx, leg1Tx, oneTimeAddress }, exitTx,
    seconds: { toSpendable, payment, total } };
}

async function main(): Promise<void> {
  // --reuse pays from a note that is already in the pool; --no-exit leaves the change there for the next run.
  const { values: flags } = parseArgs({ options: { reuse: { type: 'boolean' }, 'no-exit': { type: 'boolean' } } });
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
    if (settings.network === 'mainnet') {
      const unit = assetWireUnit(deployment.asset);
      log(`CAUTION: this demo spends real ${unit === 'lovelace' ? 'ADA' : unit}. Submitted transactions cannot be undone.`);
    }
    const result = await runDemo({ ctx: { provider: blockfrostProvider(settings.blockfrostProjectId, settings.network), deployment },
      indexerUrl: process.env.INDEXER_URL ?? 'http://127.0.0.1:4010',
      relayerUrl: process.env.RELAYER_URL ?? 'http://127.0.0.1:4011',
      sellerUrl: process.env.SELLER_URL ?? 'http://127.0.0.1:4021', walletSeed, agentSeed,
      artifacts: { spend: await keys.load('spend'), ragequit: await keys.load('ragequit') },
      // A new pool must never load notes that belong to the previous pool.
      storePath: join(root, `deployments/${settings.network}/demo-store-${deployment.poolId.slice(0, 8)}.json`),
      reuseNote: flags.reuse ?? false, exit: !(flags['no-exit'] ?? false), log });
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
