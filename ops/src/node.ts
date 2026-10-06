import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ApiError, relayerRoutes, serveJson } from '@zbase-cardano/api';
import { AspService } from '@zbase-cardano/asp';
import { Crank } from '@zbase-cardano/crank';
import { vkToCardano, type SnarkjsVk } from '@zbase-cardano/crypto';
import { Indexer, serveIndexer } from '@zbase-cardano/indexer';
import {
  loadArtifacts, loadDevArtifacts, loadDevVkey, shutdown,
  type CircuitArtifacts, type CircuitManifest, type CircuitName,
} from '@zbase-cardano/prover';
import { Relayer } from '@zbase-cardano/relayer';
import { blockfrostProvider, vkToHex, type ChainContext, type ChainHistory, type Deployment } from '@zbase-cardano/txlib';
import { readSettings } from './env.js';
import { roleSeed } from './roles.js';

export interface NodeOptions {
  ctx: ChainContext;
  history: ChainHistory;
  seeds: { crank: Uint8Array; relayer: Uint8Array; asp: Uint8Array };
  insertArtifacts: CircuitArtifacts;
  spendVkey: SnarkjsVk;
  ports?: { indexer?: number; relayer?: number };
  intervalMs?: number;
  aspStorePath?: string;
  log?: (line: string) => void;
}
export interface ZbaseNode {
  indexer: Indexer; crank: Crank; asp: AspService; relayer: Relayer;
  urls: { indexer: string; relayer: string };
  /** Sync, crank, sync, ASP, sync. Failed steps are logged. Concurrent callers share one round. */
  tick(): Promise<void>;
  close(): Promise<void>;
}

/** Keep each error on one line and redact credentials even in a nested provider message. */
export function redactedLog(log: (line: string) => void, secrets: string[]): (line: string) => void {
  return line => {
    for (const secret of secrets.filter(Boolean)) {
      for (const value of [secret, secret.toLowerCase(), secret.toUpperCase()]) line = line.split(value).join('[redacted]');
    }
    log(line.replace(/[\r\n]+/g, ' '));
  };
}
const message = (error: unknown): string => error instanceof Error ? error.message : 'Unknown failure';

export async function startNode(o: NodeOptions): Promise<ZbaseNode> {
  const intervalMs = o.intervalMs ?? 10_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) {
    throw new RangeError('intervalMs must be a nonnegative timer interval');
  }
  const log = redactedLog(o.log ?? (() => {}), Object.values(o.seeds).map(seed => Buffer.from(seed).toString('hex')));
  if (o.aspStorePath) await mkdir(dirname(o.aspStorePath), { recursive: true });
  let asp: AspService;
  const indexer = new Indexer({ ctx: o.ctx, history: o.history, aspLeaves: root => asp.leaves(root) });
  asp = new AspService({ ctx: o.ctx, indexer, payerSeed: o.seeds.asp, operatorSeeds: [o.seeds.asp], storePath: o.aspStorePath });
  const crank = new Crank({ ctx: o.ctx, indexer, seed: o.seeds.crank, artifacts: o.insertArtifacts });
  const relayer = new Relayer({ ctx: o.ctx, indexer, seed: o.seeds.relayer, vkey: o.spendVkey,
    log: (line, error) => log(`relayer: ${line}${error === undefined ? '' : `: ${message(error)}`}`) });
  const indexerServer = await serveIndexer(indexer, { port: o.ports?.indexer ?? 4010, syncMs: 0,
    onError: error => log(`indexer: ${message(error)}`) });
  let closed = false;
  const requests = new Set<Promise<unknown>>();
  let relayerServer;
  try {
    relayerServer = await serveJson(relayerRoutes(relayer).map(route => ({ ...route, handle: request => {
      if (closed) throw new ApiError('internal', 'Node is stopping', 503);
      // An accepted settlement must finish before the CLI terminates the prover workers.
      const pending = Promise.resolve().then(() => route.handle(request)).finally(() => { requests.delete(pending); });
      requests.add(pending);
      return pending;
    } })), o.ports?.relayer ?? 4011);
  }
  catch (error) { await indexerServer.close(); throw error; }
  let running: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function tick(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const events: string[] = [];
      async function sync() {
        try {
          const count = await indexer.sync();
          if (count > 0) events.push(`indexed ${count}`);
        } catch (error) { log(`indexer: ${message(error)}`); }
      }
      await sync();
      try {
        const result = await crank.tick();
        if (result) events.push(`insert ${result.txId} (${result.deposits} deposits, ${result.notes} notes)`);
      } catch (error) { log(`crank: ${message(error)}`); }
      await sync();
      try {
        const result = await asp.tick();
        if (result.txId) events.push(`asp ${result.txId} (${result.approved} approvals)`);
      } catch (error) { log(`asp: ${message(error)}`); }
      await sync();
      if (events.length > 0) log(`round: ${events.join('; ')}`);
    })().finally(() => { running = undefined; });
    return running;
  }
  function schedule() {
    timer = setTimeout(() => { void tick().finally(() => { if (!closed) schedule(); }); }, intervalMs);
    timer.unref();
  }
  // The initial round warms the HTTP snapshot, including a slow cold replay.
  await tick();
  if (intervalMs > 0) schedule();
  return { indexer, crank, asp, relayer, urls: { indexer: indexerServer.url, relayer: relayerServer.url }, tick,
    close() {
      closing ??= (async () => {
        closed = true;
        clearTimeout(timer);
        await running;
        await Promise.allSettled([...requests]);
        await Promise.all([indexerServer.close(), relayerServer.close()]);
      })();
      return closing;
    },
  };
}

/** Select the setup by its verification keys, never by which local key directory exists. */
export async function deploymentArtifacts(deployment: Deployment, root = fileURLToPath(new URL('../../', import.meta.url))): Promise<{
  spendVkey: SnarkjsVk; load(circuit: CircuitName): Promise<CircuitArtifacts>;
}> {
  const names = ['spend', 'insert', 'ragequit'] as const;
  const dev = await Promise.all(names.map(name => loadDevVkey(name, root)));
  const matches = (keys: SnarkjsVk[]) => names.every((name, i) =>
    isDeepStrictEqual(vkToHex(vkToCardano(keys[i]!)), deployment.vkeys[name]));
  if (matches(dev)) return { spendVkey: dev[0]!, load: circuit => loadDevArtifacts(circuit, root) };
  const published = join(root, `deployments/${deployment.network}/keys`);
  const manifest = JSON.parse(await readFile(join(published, 'manifest.json'), 'utf8')) as { circuits: CircuitManifest };
  const keys = await Promise.all(names.map(async name => {
    const bytes = await readFile(join(published, `${name}_vkey.json`));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.circuits[name]?.vkey_sha256) {
      throw new Error(`Verification key hash mismatch for ${name}`);
    }
    return JSON.parse(bytes.toString('utf8')) as SnarkjsVk;
  }));
  if (!matches(keys)) throw new Error('Verification keys do not match the deployment record');
  return { spendVkey: keys[0]!, load: circuit => loadArtifacts({ circuit, manifest: manifest.circuits,
    wasmPath: join(root, `circuits/build/${circuit}_js/${circuit}.wasm`),
    zkeyPath: join(root, `circuits/build/keys-${deployment.network}/${circuit}.zkey`),
    vkeyPath: join(published, `${circuit}_vkey.json`),
  }) };
}

async function main(): Promise<void> {
  const settings = readSettings();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const deployment = JSON.parse(await readFile(join(root, `deployments/${settings.network}.json`), 'utf8')) as Deployment;
  if (deployment.network !== settings.network) throw new Error('Deployment network does not match NETWORK');
  const provider = blockfrostProvider(settings.blockfrostProjectId, settings.network);
  const keys = await deploymentArtifacts(deployment, root);
  const seeds = { crank: roleSeed(settings.operatorSeed, 'crank'), relayer: roleSeed(settings.operatorSeed, 'relayer'),
    asp: roleSeed(settings.operatorSeed, 'asp') };
  const log = redactedLog(console.log, [settings.blockfrostProjectId, Buffer.from(settings.operatorSeed).toString('hex'),
    ...Object.values(seeds).map(seed => Buffer.from(seed).toString('hex'))]);
  if (settings.network === 'mainnet') log('CAUTION: the node spends real ADA. Submitted transactions cannot be undone.');
  const node = await startNode({ ctx: { provider, deployment }, history: provider, seeds,
    insertArtifacts: await keys.load('insert'), spendVkey: keys.spendVkey,
    aspStorePath: join(root, `deployments/${settings.network}/asp-store.json`), log });
  log(`Indexer ${node.urls.indexer}; relayer ${node.urls.relayer}`);
  const stop = () => {
    void node.close().then(shutdown).catch(error => { log(message(error)); process.exitCode = 1; }).finally(() => {
      settings.operatorSeed.fill(0);
      Object.values(seeds).forEach(seed => seed.fill(0));
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    redactedLog(console.error, [process.env.OPERATOR_SEED_HEX ?? '', process.env.BLOCKFROST_PROJECT_ID ?? ''])(message(error));
    await shutdown();
    process.exitCode = 1;
  }
}
