import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { IndexerClient, RelayerClient } from '@zx402/api';
import { createZx402, fileStore } from '@zx402/core';
import { addressFromBech32 } from '@zx402/crypto';
import { shutdown, type CircuitArtifacts } from '@zx402/prover';
import { assetAmount, assetUnit, assetWireUnit, blockfrostProvider, enterpriseAddress, type ChainContext, type Deployment } from '@zx402/txlib';
import { explorerUrl } from './demo.js';
import { readSettings } from './env.js';
import { deploymentArtifacts, redactedLog } from './node.js';
import { roleSeed } from './roles.js';

export interface MasumiOptions {
  ctx: ChainContext;
  indexerUrl: string; relayerUrl: string;
  agentAsset: string; input: Record<string, unknown>;
  masumiNodeUrl: string; masumiApiKey: string; purchaseWallet: string;
  blockfrostProjectId: string;
  blockfrostUrl?: string;
  fetch?: typeof fetch;
  walletSeed: Uint8Array; agentSeed: Uint8Array;
  artifacts: { spend: CircuitArtifacts; ragequit: CircuitArtifacts };
  storePath?: string;
  /** Deposit 10 tUSDM first even when a note in the pool already covers the price, for an end-to-end demo. */
  deposit?: boolean;
  poll?: { intervalMs?: number; timeoutMs?: number; onPoll?: () => void | Promise<void> };
  log?: (line: string) => void;
}
export interface MasumiResult {
  depositTx: string | null; settleTx: string | null; lockTx: string;
  jobId: string; blockchainIdentifier: string; result: unknown;
  seconds: { total: number };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label}: expected a nonempty string`);
  return value;
}
// Remote text goes to the terminal, so control, escape, line separator and bidi characters are dropped first.
function printable(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
}
function chunks(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return value.join('');
  throw new Error(`${label}: expected a string or string chunks`);
}
function decimal(value: unknown, label: string): string {
  // Safe integer times can be serialized without losing milliseconds.
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) throw new Error(`${label}: expected a decimal integer`);
  return text;
}
function baseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API base URL must use HTTP or HTTPS without credentials, a query, or a fragment');
  }
  return url.href.replace(/\/$/, '');
}

export async function runMasumi(o: MasumiOptions): Promise<MasumiResult> {
  const start = performance.now();
  const elapsed = () => ((performance.now() - start) / 1000).toFixed(3);
  const log = redactedLog(o.log ?? (() => {}), [o.masumiApiKey, o.blockfrostProjectId,
    ...[o.walletSeed, o.agentSeed].map(seed => Buffer.from(seed).toString('hex'))]);
  const step = (text: string) => log(`${text} in ${elapsed()} seconds`);
  if (o.ctx.deployment.network !== 'preprod') throw new Error('Masumi purchases require a Preprod pool');
  if (!/^[0-9a-fA-F]{56}(?:[0-9a-fA-F]{2}){0,32}$/.test(o.agentAsset)) throw new Error('Malformed registry asset hex');
  object(o.input, 'input');
  if (addressFromBech32(o.purchaseWallet, 'preprod').payment.kind !== 'key') {
    throw new Error('MASUMI_PURCHASE_WALLET must be a Preprod key address');
  }
  if (!o.masumiApiKey) throw new Error('Missing MASUMI_API_KEY');
  const nodeUrl = baseUrl(o.masumiNodeUrl);
  const blockfrostUrl = baseUrl(o.blockfrostUrl ?? 'https://cardano-preprod.blockfrost.io/api/v0');
  const fetcher = o.fetch ?? fetch;
  const timeoutMs = o.poll?.timeoutMs ?? 600_000;
  const intervalMs = o.poll?.intervalMs ?? 3_000;
  for (const value of [timeoutMs, intervalMs]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Polling settings must be nonnegative safe integers');
  }
  const request = async (url: string, label: string, init: RequestInit = {}, deadline?: number): Promise<Record<string, unknown>> => {
    const remaining = deadline === undefined ? 30_000 : Math.max(1, Math.min(30_000, deadline - Date.now()));
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(remaining) });
    if (!response.ok) {
      await response.body?.cancel();
      // Remote error bodies can echo credentials or private input.
      throw new Error(`${label} failed with HTTP ${response.status}`);
    }
    return object(await response.json(), label);
  };
  const poll = async <T>(read: (deadline: number) => Promise<T | undefined>, label: string, limit = timeoutMs): Promise<T> => {
    const deadline = Date.now() + limit;
    for (;;) {
      await o.poll?.onPoll?.();
      const result = await read(deadline);
      if (result !== undefined) return result;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label} after ${limit / 1000} seconds`);
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  };
  const metadataResponse = await request(`${blockfrostUrl}/assets/${o.agentAsset}`, 'Agent metadata',
    { headers: { project_id: o.blockfrostProjectId } });
  const metadata = object(metadataResponse.onchain_metadata, 'Agent metadata');
  const apiBase = baseUrl(chunks(metadata.api_base_url, 'api_base_url'));
  const pricing = object(metadata.agentPricing, 'agentPricing').fixedPricing;
  if (!Array.isArray(pricing) || pricing.length !== 1) throw new Error('Agent must advertise one fixed price in the pool asset');
  const price = object(pricing[0], 'fixedPricing');
  const priceUnit = chunks(price.unit, 'price unit') || 'lovelace';
  const poolUnit = assetUnit(o.ctx.deployment.asset);
  if (priceUnit !== poolUnit || poolUnit === 'lovelace') {
    throw new Error(`Agent price unit ${priceUnit} does not match the token pool asset ${poolUnit}`);
  }
  const amount = BigInt(decimal(price.amount, 'price amount'));
  if (amount <= 0n) throw new Error('Agent price must be positive');
  step(`Agent ${printable(chunks(metadata.name, 'name'))}: ${apiBase}, price ${amount} ${assetWireUnit(o.ctx.deployment.asset)}`);
  const availability = await request(`${apiBase}/availability`, 'Agent availability');
  if (availability.status !== 'available') throw new Error('Masumi agent is not available');
  const schema = await request(`${apiBase}/input_schema`, 'Agent input schema');
  // The schema is only checked for presence; agents answer with an array or an object of fields.
  if (schema.input_data === undefined || schema.input_data === null) {
    throw new Error(`Agent input schema must contain input_data, got keys ${printable(Object.keys(schema).join(', ')) || 'none'}`);
  }
  step('Agent is available and its input schema is loaded');

  if (o.storePath) await mkdir(dirname(o.storePath), { recursive: true });
  const relayer = new RelayerClient(o.relayerUrl);
  const sdk = createZx402({ seed: o.agentSeed, ctx: o.ctx, indexer: new IndexerClient(o.indexerUrl), relayer,
    artifacts: o.artifacts, ...(o.storePath ? { store: fileStore(o.storePath) } : {}), poll: o.poll });
  await sdk.sync();
  const quote = await relayer.quote([{ address: o.purchaseWallet, amount, datumHash: null }]);
  if (quote.relayerFee < 0n || quote.relayerFee > 2_000_000n || quote.protocolFee < 0n
    || quote.withdrawn !== amount + quote.relayerFee + quote.protocolFee || quote.poolId !== o.ctx.deployment.poolId) {
    throw new Error('Relayer quote does not match the payment or exceeds the fee limit');
  }
  // One Settle spends one note, so a sum of smaller notes cannot cover the purchase.
  const coversPrice = () => sdk.balance().spendable >= quote.withdrawn
    && sdk.listNotes().some(note => note.status === 'spendable' && !note.pending && note.value !== null && note.value >= quote.withdrawn);
  let depositTx: string | null = null;
  if (o.deposit || !coversPrice()) {
    const deposit = await sdk.deposit({ amount: 10_000_000n, walletSeed: o.walletSeed });
    depositTx = deposit.txId;
    step(`Deposit ${depositTx} submitted`);
    await sdk.waitForNote(deposit.prepared.noteId);
    step(`Deposit ${depositTx} is spendable`);
  }
  if (!coversPrice()) throw new Error('No single spendable note covers the price plus fees after the 10 tUSDM deposit');
  step(`Spendable note covers price ${amount} plus fees ${quote.relayerFee + quote.protocolFee}`);

  const balance = async () => (await o.ctx.provider.getUtxosAt(o.purchaseWallet))
    .reduce((sum, utxo) => sum + assetAmount(utxo.value, o.ctx.deployment.asset), 0n);
  let settleTx: string | null = null;
  if (await balance() < amount) {
    const receipt = await sdk.settlePrivately({ payouts: [{ address: o.purchaseWallet, amount }], minPayoutLovelace: 2_000_000n });
    settleTx = receipt.txHash;
    step(`Settle ${settleTx} submitted`);
    const settled = await sdk.waitForSettle(receipt.id);
    settleTx = settled.txHash;
    await poll(async () => await balance() >= amount ? true : undefined, 'the purchasing wallet funds');
    step(`Settle ${settleTx} confirmed and purchasing wallet funded`);
  } else {
    step('Purchasing wallet already holds the price');
  }

  const identifierFromPurchaser = randomBytes(10).toString('hex');
  const job = await request(`${apiBase}/start_job`, 'Start job', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier_from_purchaser: identifierFromPurchaser, input_data: o.input }) });
  const jobId = string(job.job_id, 'job_id');
  const blockchainIdentifier = string(job.blockchainIdentifier, 'blockchainIdentifier');
  step(`Job ${printable(jobId)} started with blockchainIdentifier ${printable(blockchainIdentifier)}`);
  // Some agents omit the amounts; the node checks the purchase against the registry price anyway.
  if (job.amounts !== undefined && job.amounts !== null) {
    if (!Array.isArray(job.amounts) || job.amounts.length !== 1) throw new Error('Job amounts do not match the advertised price');
    const jobAmount = object(job.amounts[0], 'job amount');
    if (jobAmount.unit !== poolUnit || BigInt(decimal(jobAmount.amount, 'job amount')) !== amount) {
      throw new Error('Job amounts do not match the advertised price');
    }
  }
  // The node infers the contract version (V1 or V2) from the blockchainIdentifier the agent signed.
  const purchase = { blockchainIdentifier, network: 'Preprod',
    inputHash: string(job.input_hash, 'input_hash'), sellerVkey: string(job.sellerVKey ?? job.sellerVkey, 'sellerVkey'),
    agentIdentifier: string(job.agentIdentifier, 'agentIdentifier'),
    Amounts: [{ amount: String(amount), unit: poolUnit }],
    payByTime: decimal(job.payByTime, 'payByTime'), submitResultTime: decimal(job.submitResultTime, 'submitResultTime'),
    unlockTime: decimal(job.unlockTime, 'unlockTime'), externalDisputeUnlockTime: decimal(job.externalDisputeUnlockTime, 'externalDisputeUnlockTime'),
    identifierFromPurchaser };
  const nodeHeaders = { token: o.masumiApiKey, 'Content-Type': 'application/json' };
  const created = await request(`${nodeUrl}/api/v1/purchase/`, 'Create purchase', {
    method: 'POST', headers: nodeHeaders, body: JSON.stringify(purchase) });
  if (created.status === 'error') throw new Error('Masumi node refused the purchase');
  const source = object(object(created.data, 'Create purchase data').PaymentSource, 'PaymentSource');
  const sourceType = string(source.paymentSourceType, 'paymentSourceType');
  step(`Masumi purchase ${printable(blockchainIdentifier)} created on a ${printable(sourceType)} source`);
  // The list defaults to V1 purchases, so it is filtered by the source type of this purchase.
  const query = new URLSearchParams({ network: 'Preprod', limit: '50', filterPaymentSourceType: sourceType });
  const lockTx = await poll(async deadline => {
    const response = await request(`${nodeUrl}/api/v1/purchase/?${query}`, 'Purchase list', { headers: nodeHeaders }, deadline);
    const data = response.status === 'success' ? object(response.data, 'Purchase list data') : response;
    if (!Array.isArray(data.Purchases)) throw new Error('Masumi node did not return Purchases');
    const found = data.Purchases.map(value => object(value, 'Purchase')).find(value => value.blockchainIdentifier === blockchainIdentifier);
    if (!found) return undefined;
    // A fast seller can move the escrow past FundsLocked between two polls, so later states count too.
    const locked = ['FundsLocked', 'ResultSubmitted', 'WithdrawAuthorized', 'Withdrawn'];
    if (!locked.includes(String(found.onChainState))) return undefined;
    const transaction = found.CurrentTransaction ? object(found.CurrentTransaction, 'CurrentTransaction') : {};
    return typeof transaction.txHash === 'string' && transaction.txHash ? transaction.txHash : undefined;
  }, `Masumi purchase ${blockchainIdentifier} to reach FundsLocked`, Math.min(timeoutMs, 600_000));
  step(`Escrow FundsLocked in transaction ${printable(lockTx)}`);
  const status = await poll(async deadline => {
    const response = await request(`${apiBase}/status?${new URLSearchParams({ job_id: jobId })}`, 'Job status', {}, deadline);
    if (response.job_id !== jobId) throw new Error('Agent returned a status for another job');
    return response.status === 'completed' || response.status === 'failed' ? response : undefined;
  }, `Masumi job ${jobId} to complete`);
  step(`Job ${printable(jobId)} ${printable(status.status)}: ${printable(JSON.stringify(status.result ?? null))}`);
  if (status.status === 'failed') throw new Error(`Masumi job ${jobId} failed`);
  // Explorer links, so an audience can check every claim on chain.
  const base = explorerUrl(o.ctx.deployment.network);
  const clean = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value) ? value : 'invalid';
  const tx = (hash: unknown) => `${base}/transaction/${clean(hash, /^[0-9a-f]{64}$/)}`;
  const addr = (address: unknown) => `${base}/address/${clean(address, /^[a-z0-9_]{20,120}$/)}`;
  for (const line of ['', 'What the chain shows, on the explorer:',
    `  Pool              ${addr(o.ctx.deployment.scripts.pool.address)}`,
    `  Agent's wallet    ${addr(enterpriseAddress(o.walletSeed, o.ctx.deployment.network))}`,
    ...(depositTx ? [`  Deposit           ${tx(depositTx)}`, "                    from the agent's wallet, in public like any deposit"] : []),
    ...(settleTx ? [`  Private payment   ${tx(settleTx)}`, `                    the pool pays the Masumi node's purchasing wallet with a proof; no deposit is named`] : []),
    `  Purchasing wallet ${addr(o.purchaseWallet)}`,
    `  Escrow lock       ${tx(lockTx)}`, '                    the purchasing wallet locks the price in the Masumi escrow, as any Masumi buyer does',
    `  Escrow contract   ${addr(source.smartContractAddress)}`,
    `  Agent             ${printable(apiBase)}, job ${printable(jobId)}`,
    "Not on the chain: any link from the agent's wallet or its deposit to the purchasing wallet, the escrow or the Masumi agent."]) log(line);
  return { depositTx, settleTx, lockTx, jobId, blockchainIdentifier, result: status.result ?? null,
    seconds: { total: (performance.now() - start) / 1000 } };
}

export async function main(): Promise<void> {
  const { values } = parseArgs({ options: { agent: { type: 'string' }, input: { type: 'string' }, deposit: { type: 'boolean' } } });
  if (!values.agent || !values.input) throw new Error('Both the agent registry asset and input JSON are required');
  let input: Record<string, unknown>;
  try { input = object(JSON.parse(values.input), 'input'); }
  catch { throw new Error('Input must be a JSON object'); }
  const settings = readSettings();
  const walletSeed = roleSeed(settings.operatorSeed, 'user');
  const agentSeed = roleSeed(settings.operatorSeed, 'agent');
  const secrets = [settings.blockfrostProjectId, process.env.MASUMI_API_KEY ?? '',
    ...[settings.operatorSeed, walletSeed, agentSeed].map(seed => Buffer.from(seed).toString('hex'))];
  const log = redactedLog(console.log, secrets);
  try {
    if (settings.network !== 'preprod') throw new Error('Masumi purchases require NETWORK=preprod');
    const masumiApiKey = process.env.MASUMI_API_KEY;
    const purchaseWallet = process.env.MASUMI_PURCHASE_WALLET;
    if (!masumiApiKey || !purchaseWallet) throw new Error('MASUMI_API_KEY and MASUMI_PURCHASE_WALLET are required');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const deployment = JSON.parse(await readFile(join(root, `deployments/${settings.network}.json`), 'utf8')) as Deployment;
    if (deployment.network !== settings.network) throw new Error('Deployment network does not match NETWORK');
    const keys = await deploymentArtifacts(deployment, root);
    await runMasumi({ ctx: { provider: blockfrostProvider(settings.blockfrostProjectId, settings.network), deployment },
      indexerUrl: process.env.INDEXER_URL ?? 'http://127.0.0.1:4010',
      relayerUrl: process.env.RELAYER_URL ?? 'http://127.0.0.1:4011',
      agentAsset: values.agent, input, deposit: values.deposit ?? false, masumiNodeUrl: process.env.MASUMI_NODE_URL ?? 'http://localhost:3001',
      masumiApiKey, purchaseWallet, blockfrostProjectId: settings.blockfrostProjectId, walletSeed, agentSeed,
      artifacts: { spend: await keys.load('spend'), ragequit: await keys.load('ragequit') },
      // Reuse the demo notes, but never load notes from a different pool.
      storePath: join(root, `deployments/${settings.network}/demo-store-${deployment.poolId.slice(0, 8)}.json`), log });
  } catch (error) {
    let message = 'Masumi purchase failed';
    redactedLog(line => { message = line; }, secrets)(error instanceof Error ? error.message : message);
    throw new Error(message);
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
    redactedLog(console.error, [process.env.OPERATOR_SEED_HEX ?? '', process.env.BLOCKFROST_PROJECT_ID ?? '', process.env.MASUMI_API_KEY ?? ''])(
      error instanceof Error ? error.message : 'Masumi purchase failed');
    process.exitCode = 1;
  }
}
