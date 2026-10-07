import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { devKeysPresent, loadDevArtifacts, loadDevVkey, shutdown } from '@zx402/prover';
import { decodePoolRedeemer, decodeTx, enterpriseAddress, timeToSlot, type TxView, type Utxo } from '@zx402/txlib';
import { FakeChain } from '@zx402/txlib/testing/fake-chain';
import { startDevnet } from '@zx402/txlib/testing/devnet';
import { deploy } from '../src/deploy.js';
import { roleSeed } from '../src/roles.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const asset = { policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde', name: '0014df10745553444d' };
const unit = asset.policy + asset.name;
const registryAsset = 'ab'.repeat(28) + '01';
const input = { prompt: 'Give a short weather report' };
const job = { job_id: 'weather-1', blockchainIdentifier: 'signed-purchase-1', agentIdentifier: registryAsset,
  sellerVKey: 'bc'.repeat(28), input_hash: 'cd'.repeat(32), amounts: [{ amount: '10000', unit }],
  payByTime: '1900000000000', submitResultTime: '1900000300000', unlockTime: '1900000600000',
  externalDisputeUnlockTime: '1900000900000' };
after(shutdown);

async function command() {
  const { runMasumi } = await import('../src/masumi.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return { runMasumi: undefined };
    throw error;
  });
  assert.equal(typeof runMasumi, 'function', 'The Masumi command must expose runMasumi');
  assert.ok(runMasumi);
  return runMasumi;
}

async function server(t: TestContext, handle: (request: IncomingMessage, body: unknown) => unknown | Promise<unknown>) {
  const http = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const result = await handle(request, body ? JSON.parse(body) : undefined);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Fake server failed' }));
    }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('MASUMI-01 the pool funds the purchasing wallet and the job completes', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const runMasumi = await command();
  const { startNode } = await import('../src/node.js');
  await mkdir(join(root, 'ops/build'), { recursive: true });
  const directory = await mkdtemp(join(root, 'ops/build/masumi-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operator = new Uint8Array(32).fill(73);
  const walletSeed = roleSeed(operator, 'user');
  const agentSeed = roleSeed(operator, 'agent');
  const purchaseWallet = enterpriseAddress(new Uint8Array(32).fill(74), 'preprod');
  const chain = new FakeChain({ network: 'preprod', startSlot: timeToSlot(Date.now(), 'preprod') });
  // Proof generation takes real time, so confirmation must keep pace with wall time.
  const mine = async () => chain.mineBlock(Math.max(0, timeToSlot(Date.now(), 'preprod') - (await chain.getTip()).slot));
  chain.addUtxo({ address: enterpriseAddress(operator, 'preprod'), value: { lovelace: 400_000_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null });
  const deployment = await deploy({ provider: chain, network: 'preprod', operatorSeed: operator, asset,
    vkeys: { spend: await loadDevVkey('spend', root), insert: await loadDevVkey('insert', root),
      ragequit: await loadDevVkey('ragequit', root) }, confirm: async () => { await mine(); } });
  chain.addUtxo({ address: enterpriseAddress(walletSeed, 'preprod'),
    value: { lovelace: 5_000_000n, assets: { [unit]: 100_000_000n } },
    inlineDatum: null, datumHash: null, scriptRef: null });
  await mine();
  const ctx = { provider: chain, deployment };
  const node = await startNode({ ctx, history: chain, intervalMs: 0, ports: { indexer: 0, relayer: 0 },
    seeds: { crank: roleSeed(operator, 'crank'), relayer: roleSeed(operator, 'relayer'), asp: roleSeed(operator, 'asp') },
    insertArtifacts: await loadDevArtifacts('insert', root), spendVkey: await loadDevVkey('spend', root) });
  t.after(() => node.close());
  const transactions: { view: TxView; inputs: Utxo[] }[] = [];
  const submit = chain.submit.bind(chain);
  t.mock.method(chain, 'submit', async (cbor: string) => {
    const view = decodeTx(cbor);
    const inputs = await chain.getUtxos(view.inputs);
    const id = await submit(cbor);
    transactions.push({ view, inputs });
    return id;
  });
  const tokenBalance = async () => (await chain.getUtxosAt(purchaseWallet))
    .reduce((sum, u) => sum + (u.value.assets[unit] ?? 0n), 0n);
  const starts: Record<string, unknown>[] = [];
  const purchases: unknown[] = [];
  let statusPolls = 0;
  let purchasePolls = 0;
  let schemas = 0;
  const agentUrl = await server(t, async (request, body) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/availability') return { status: 'available' };
    if (url.pathname === '/input_schema') {
      schemas += 1;
      return { input_data: [{ id: 'prompt', type: 'string' }] };
    }
    if (url.pathname === '/start_job') {
      assert.equal(request.method, 'POST');
      assert.equal(await tokenBalance(), 10_000n, 'The private payout must confirm before starting the job');
      starts.push(body as Record<string, unknown>);
      return job;
    }
    assert.equal(url.pathname, '/status');
    assert.equal(url.searchParams.get('job_id'), job.job_id);
    assert.ok(purchasePolls >= 3, 'The job must wait for confirmed escrow funding');
    statusPolls += 1;
    return { job_id: job.job_id, status: statusPolls === 1 ? 'running' : 'completed',
      ...(statusPolls > 1 ? { result: { weather: 'sunny', temperatureC: 28 } } : {}) };
  });
  const lockTx = 'ef'.repeat(32);
  const masumiNodeUrl = await server(t, (request, body) => {
    assert.equal(request.headers.token, 'test-masumi-key');
    const url = new URL(request.url!, 'http://localhost');
    assert.equal(url.pathname, '/api/v1/purchase/');
    if (request.method === 'POST') {
      purchases.push(body);
      return { status: 'success', data: { id: 'purchase-1', blockchainIdentifier: job.blockchainIdentifier,
        PaymentSource: { paymentSourceType: 'Web3CardanoV1' } } };
    }
    assert.equal(url.searchParams.get('network'), 'Preprod');
    assert.equal(url.searchParams.get('limit'), '50');
    assert.equal(url.searchParams.get('filterPaymentSourceType'), 'Web3CardanoV1');
    purchasePolls += 1;
    return { status: 'success', data: { Purchases: [
      { blockchainIdentifier: 'another-purchase', onChainState: 'FundsLocked', CurrentTransaction: { txHash: 'wrong' } },
      ...(purchasePolls === 1 ? [] : [{ blockchainIdentifier: job.blockchainIdentifier,
        onChainState: purchasePolls === 2 ? null : 'FundsLocked',
        NextAction: { requestedAction: purchasePolls === 2 ? 'FundsLockingInitiated' : 'None' },
        CurrentTransaction: { txHash: lockTx } }]),
    ] } };
  });
  const logs: string[] = [];
  const result = await runMasumi({ ctx, indexerUrl: node.urls.indexer, relayerUrl: node.urls.relayer,
    agentAsset: registryAsset, input, masumiNodeUrl, masumiApiKey: 'test-masumi-key', purchaseWallet,
    blockfrostProjectId: 'test-blockfrost-key', walletSeed, agentSeed,
    artifacts: { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) },
    storePath: join(directory, 'demo-store.json'),
    fetch: async (url, init) => {
      if (String(url).startsWith('https://cardano-preprod.blockfrost.io/api/v0/assets/')) {
        assert.equal(String(url), `https://cardano-preprod.blockfrost.io/api/v0/assets/${registryAsset}`);
        assert.equal(new Headers(init?.headers).get('project_id'), 'test-blockfrost-key');
        return Response.json({ onchain_metadata: { name: 'Weather agent', api_base_url: [agentUrl.slice(0, 8), agentUrl.slice(8)],
          agentPricing: { fixedPricing: [{ unit: [asset.policy, asset.name], amount: '10000' }] } } });
      }
      return fetch(url, init);
    },
    poll: { intervalMs: 0, timeoutMs: 900_000, onPoll: async () => { await mine(); await node.tick(); } },
    log: line => { logs.push(line); t.diagnostic(line); },
  });
  assert.equal(await tokenBalance(), 10_000n);
  const payments = transactions.filter(tx => tx.view.outputs.some(out => out.address === purchaseWallet));
  assert.equal(payments.length, 1);
  const payment = payments[0]!;
  const poolInput = payment.inputs.find(u => u.address === deployment.scripts.pool.address);
  assert.ok(poolInput, 'The payout must spend the pool UTXO');
  const redeemer = payment.view.redeemers.find(r => r.tag === 'spend'
    && r.index === payment.view.inputs.findIndex(ref => ref.txId === poolInput.ref.txId && ref.index === poolInput.ref.index));
  assert.ok(redeemer);
  assert.equal(decodePoolRedeemer(redeemer.dataCbor).kind, 'Settle');
  assert.equal(payment.view.outputs.find(out => out.address === purchaseWallet)!.value.assets[unit], 10_000n);
  assert.equal(payment.view.outputs.find(out => out.address === purchaseWallet)!.value.lovelace, 2_000_000n);
  assert.ok(chain.transaction(payment.view.txId)?.block);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0]!.input_data, input);
  assert.match(String(starts[0]!.identifier_from_purchaser), /^[0-9a-f]{14,26}$/);
  assert.deepEqual(purchases, [{ blockchainIdentifier: job.blockchainIdentifier, network: 'Preprod',
    inputHash: job.input_hash, sellerVkey: job.sellerVKey,
    agentIdentifier: registryAsset, Amounts: [{ amount: '10000', unit }], payByTime: job.payByTime,
    submitResultTime: job.submitResultTime, unlockTime: job.unlockTime, externalDisputeUnlockTime: job.externalDisputeUnlockTime,
    identifierFromPurchaser: starts[0]!.identifier_from_purchaser }]);
  assert.equal(schemas, 1);
  assert.equal(result.settleTx, payment.view.txId);
  assert.equal(result.lockTx, lockTx);
  assert.deepEqual(result.result, { weather: 'sunny', temperatureC: 28 });
  for (const text of [payment.view.txId, lockTx, 'sunny', job.job_id, job.blockchainIdentifier]) {
    assert.ok(logs.some(line => line.includes(text)), `The command must print ${text}`);
  }
  for (const secret of ['test-masumi-key', 'test-blockfrost-key', ...[walletSeed, agentSeed].map(seed => Buffer.from(seed).toString('hex'))]) {
    assert.ok(!logs.join('\n').includes(secret), 'Credentials must stay out of logs');
  }
});

test('MASUMI-02 a wrong price unit is refused', { timeout: 120_000 }, async t => {
  const runMasumi = await command();
  const { chain, ctx, keys } = await startDevnet({ asset });
  const submit = t.mock.method(chain, 'submit');
  const requests: string[] = [];
  // Rejection needs verification keys only, so this safety check also runs in CI.
  const artifacts = { wasm: 'unused', zkey: 'unused', vkey: await loadDevVkey('spend', root) };
  await assert.rejects(runMasumi({ ctx, indexerUrl: 'http://127.0.0.1:1', relayerUrl: 'http://127.0.0.1:1',
    agentAsset: registryAsset, input, masumiNodeUrl: 'http://127.0.0.1:1', masumiApiKey: 'test-masumi-key',
    purchaseWallet: enterpriseAddress(keys.users[1]!, 'preprod'), blockfrostProjectId: 'test-blockfrost-key',
    walletSeed: keys.users[0]!, agentSeed: keys.users[0]!, artifacts: { spend: artifacts, ragequit: artifacts },
    fetch: async url => {
      requests.push(String(url));
      return Response.json({ onchain_metadata: { name: 'ADA agent', api_base_url: 'http://127.0.0.1:1',
        agentPricing: { fixedPricing: [{ unit: [], amount: '10000' }] } } });
    },
  }), /price unit.*lovelace.*pool asset/i);
  assert.equal(submit.mock.callCount(), 0);
  assert.deepEqual(requests, [`https://cardano-preprod.blockfrost.io/api/v0/assets/${registryAsset}`]);
});
