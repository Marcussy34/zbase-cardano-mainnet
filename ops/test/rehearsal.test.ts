import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Server, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FacilitatorCardanoSigner } from '@x402/cardano';
import { IndexerClient, RelayerClient } from '@zbase-cardano/api';
import { fileStore } from '@zbase-cardano/core';
import { addressFromBech32, deriveNoteSecrets, vkToCardano } from '@zbase-cardano/crypto';
import { devKeysPresent, loadDevArtifacts, loadDevVkey, shutdown } from '@zbase-cardano/prover';
import {
  decodePoolRedeemer, decodeTx, enterpriseAddress, readPool, timeToSlot, vkToHex,
  type TxView, type Utxo,
} from '@zbase-cardano/txlib';
import { FakeChain } from '@zbase-cardano/txlib/testing/fake-chain';
import { startSeller } from '@zbase-cardano/example-x402-seller/src/seller.js';
import { deploy } from '../src/deploy.js';
import { roleSeed } from '../src/roles.js';
import type { DemoResult } from '../src/demo.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const price = 2_000_000n;
const total = (utxos: Utxo[]) => utxos.reduce((sum, u) => sum + u.value.lovelace, 0n);
after(shutdown);

// Only the chain adapter differs from the stock seller and facilitator.
function facilitator(chain: FakeChain): FacilitatorCardanoSigner {
  return {
    getAddresses: () => [],
    async getUtxo(ref, network) {
      assert.equal(network, 'cardano:preprod');
      const u = chain.allUtxos().find(u => `${u.ref.txId}#${u.ref.index}` === ref);
      if (!u) return { exists: false };
      const payment = addressFromBech32(u.address, 'preprod').payment;
      assert.equal(payment.kind, 'key');
      return { exists: true, address: u.address, coin: u.value.lovelace, assets: u.value.assets,
        paymentKeyHash: Buffer.from(payment.hash).toString('hex') };
    },
    async getCurrentSlot() { return BigInt((await chain.getTip()).slot); },
    async getProtocolParameters() {
      const p = await chain.getProtocolParameters();
      return { coinsPerUtxoByte: p.coinsPerUtxoByte, minFeeCoefficient: p.minFeeA, minFeeConstant: p.minFeeB };
    },
    async evaluateTransaction(transaction) {
      await chain.evaluate(Buffer.from(transaction, 'base64').toString('hex'));
    },
    async submitTransaction(transaction) {
      const txHash = await chain.submit(Buffer.from(transaction, 'base64').toString('hex'));
      chain.mineBlock();
      chain.mineBlock();
      return { txHash, status: 'mempool' };
    },
    async getTransactionEvidence(hash) {
      const block = chain.transaction(hash)?.block;
      return block ? { status: 'confirmed', confirmations: chain.blocks().length - block.height }
        : { status: 'unknown', confirmations: 0 };
    },
  };
}

test('E2E-01 through E2E-04: deployed pool rehearsal through real HTTP and stock x402', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { startNode } = await import('../src/node.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return { startNode: undefined };
    throw error;
  });
  assert.equal(typeof startNode, 'function', 'The node must expose startNode');
  assert.ok(startNode);
  const { runDemo } = await import('../src/demo.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return { runDemo: undefined };
    throw error;
  });
  assert.equal(typeof runDemo, 'function', 'The demo must expose runDemo');
  assert.ok(runDemo);
  const directory = await mkdtemp(join(tmpdir(), 'zbase-rehearsal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = join(directory, 'demo-store.json');
  const operator = new Uint8Array(32).fill(71);
  const walletSeed = roleSeed(operator, 'user');
  const agentSeed = roleSeed(operator, 'agent');
  const network = 'preprod';
  const wallet = enterpriseAddress(walletSeed, network);
  const seller = enterpriseAddress(roleSeed(operator, 'seller'), network);
  // Match wall time because the live relayer quotes POSIX validity deadlines.
  const chain = new FakeChain({ network, startSlot: timeToSlot(Date.now(), network) });
  chain.addUtxo({ address: enterpriseAddress(operator, network), value: { lovelace: 400_000_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null });
  const transactions: { view: TxView; inputs: Utxo[] }[] = [];
  const submit = chain.submit.bind(chain);
  t.mock.method(chain, 'submit', async (cbor: string) => {
    const view = decodeTx(cbor);
    const inputs = await chain.getUtxos(view.inputs);
    const id = await submit(cbor);
    transactions.push({ view, inputs });
    return id;
  });
  const logs: string[] = [];
  const started = performance.now();
  const deployment = await deploy({ provider: chain, network, operatorSeed: operator,
    vkeys: { spend: await loadDevVkey('spend', root), insert: await loadDevVkey('insert', root),
      ragequit: await loadDevVkey('ragequit', root) },
    config: { depositFeeBps: 50, settleFeeBps: 100 },
    confirm: async () => { chain.mineBlock(); }, log: line => logs.push(line),
  });
  t.diagnostic(`Deployment seconds: ${((performance.now() - started) / 1000).toFixed(3)}`);
  const ctx = { provider: chain, deployment };
  const reserve = (await readPool(ctx)).balance;
  const nodeOptions = { ctx, history: chain, intervalMs: 0, ports: { indexer: 0, relayer: 0 },
    seeds: { crank: roleSeed(operator, 'crank'), relayer: roleSeed(operator, 'relayer'), asp: roleSeed(operator, 'asp') },
    insertArtifacts: await loadDevArtifacts('insert', root), spendVkey: await loadDevVkey('spend', root),
    aspStorePath: join(directory, 'asp-store.json'), log: (line: string) => logs.push(line),
  };
  const node = await startNode(nodeOptions);
  t.after(() => node.close());
  const server = await startSeller({ port: 0, network: 'cardano:preprod', payTo: seller,
    priceLovelace: price, blockfrostProjectId: '', facilitatorSigner: facilitator(chain) });
  t.after(() => server.close());
  const served: { url: string; body: string }[] = [];
  const ports = new Set(Object.values(node.urls).map(url => Number(new URL(url).port)));
  const emit = Server.prototype.emit;
  t.mock.method(Server.prototype, 'emit', function (this: Server, event: string | symbol, ...args: unknown[]) {
    if (event === 'request') {
      const request = args[0] as IncomingMessage;
      if (ports.has(request.socket.localPort!)) {
        const entry = { url: request.url ?? '', body: '' };
        served.push(entry);
        request.on('data', (chunk: Buffer) => { entry.body += chunk.toString('utf8'); });
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  });

  await t.test('E2E-04: a failed crank read does not stop the round or the next round', async () => {
    await node.tick();
    const sync = t.mock.method(node.indexer, 'sync');
    const approval = t.mock.method(node.asp, 'tick');
    const getUtxosAt = chain.getUtxosAt.bind(chain);
    let failOnce = true;
    const failing = t.mock.method(chain, 'getUtxosAt', async (address: string) => {
      if (failOnce && address === deployment.scripts.pool.address) {
        failOnce = false;
        throw new Error('transient crank provider failure');
      }
      return getUtxosAt(address);
    });
    try {
      await node.tick();
      assert.equal(failOnce, false);
      assert.equal(sync.mock.callCount(), 3);
      assert.equal(approval.mock.callCount(), 1);
      assert.ok(logs.some(line => /crank.*transient crank provider failure/i.test(line)));
      await node.tick();
      assert.equal((await new IndexerClient(node.urls.indexer).getPool()).poolId, deployment.poolId);
    } finally {
      failing.mock.restore();
      sync.mock.restore();
      approval.mock.restore();
    }
  });

  const options = { ctx, indexerUrl: node.urls.indexer, relayerUrl: node.urls.relayer, sellerUrl: server.url,
    walletSeed, agentSeed, storePath,
    artifacts: { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) },
    poll: { intervalMs: 0, timeoutMs: 900_000, onPoll: async () => { chain.mineBlock(); await node.tick(); } },
    log: (line: string) => { logs.push(line); t.diagnostic(line); },
  };
  let first: DemoResult;
  const runStart = transactions.length;
  const checkStory = async (result: DemoResult, start: number, count: number) => {
    assert.equal(result.paid.status, 200);
    assert.deepEqual(JSON.parse(result.paid.body), { weather: 'sunny', temperatureC: 28 });
    assert.ok(result.paid.settlementTx);
    assert.equal(total(await chain.getUtxosAt(seller)), price * BigInt(count));
    const payment = transactions.find(tx => tx.view.txId === result.paid.settlementTx)!;
    assert.ok(payment);
    assert.equal(payment.view.inputs.length, 1);
    assert.equal(payment.inputs[0]!.address, result.paid.oneTimeAddress);
    assert.equal(payment.view.inputs[0]!.txId, result.paid.leg1Tx);
    assert.equal(payment.view.outputs.length, 1);
    assert.equal(payment.view.outputs[0]!.address, seller);
    assert.equal(payment.view.outputs[0]!.value.lovelace, price);
    assert.notEqual(result.paid.oneTimeAddress, wallet);
    assert.equal(result.noteValue, 9_650_000n);
    for (const tx of transactions.filter(tx => tx.view.outputs.some(out => out.address === seller))) {
      assert.ok(tx.inputs.every(input => input.address !== wallet));
      assert.ok(tx.view.outputs.every(out => out.address !== wallet));
    }
    assert.ok(result.exitTx);
    const exit = transactions.find(tx => tx.view.txId === result.exitTx)!;
    assert.ok(exit && chain.transaction(result.exitTx)?.block);
    const store = (await fileStore(storePath).load())!;
    const exited = store.notes.filter(note => note.status === 'exited');
    assert.equal(exited.length, count);
    assert.equal(store.notes.filter(note => !['spent', 'exited'].includes(note.status)).length, 0);
    const refund = total(exit.view.outputs.filter(out => out.address === wallet).map((out, index) =>
      ({ ...out, ref: { txId: exit.view.txId, index } })));
    assert.equal(refund - total(exit.inputs.filter(input => input.address === wallet)), exited.at(-1)!.value! - exit.view.fee);
    const pool = await readPool(ctx);
    assert.ok(pool.datum.feesAccrued > 0n);
    assert.equal(pool.balance, reserve + pool.datum.feesAccrued);
    assert.deepEqual(pool.datum.queue, []);
    assert.ok(transactions.slice(start).every(tx => logs.some(line => line.includes(tx.view.txId))), 'Every story transaction must be logged');
    assert.ok(result.seconds.toSpendable > 0 && result.seconds.payment > 0);
    assert.ok(result.seconds.total >= result.seconds.toSpendable + result.seconds.payment);
  };
  await t.test('E2E-01, E2E-02: weather payment, private settlement, confirmed exit, and exact solvency', async () => {
    first = await runDemo(options);
    await checkStory(first, runStart, 1);
  });
  await t.test('E2E-03: a second demo resumes the store with new note and one-time indexes', async () => {
    const start = transactions.length;
    const second = await runDemo(options);
    await checkStory(second, start, 2);
    assert.notEqual(second.depositTx, first.depositTx);
    assert.notEqual(second.paid.oneTimeAddress, first.paid.oneTimeAddress);
    const store = (await fileStore(storePath).load())!;
    assert.equal(store.nextDepositIndex, 2);
    assert.equal(store.nextOneTimeIndex, 2);
    assert.deepEqual(store.notes.filter(note => note.kind === 'deposit').map(note => note.secretIndex), [0, 1]);
  });
  await t.test('E2E-01: incoming HTTP URLs and bodies never contain raw note secrets', async () => {
    assert.ok(served.some(request => request.url === '/v1/settle' && request.body.includes('publicInputs')));
    assert.ok(served.some(request => request.url.startsWith('/v1/leaves?')));
    const store = (await fileStore(storePath).load())!;
    const observed = JSON.stringify(served) + logs.join('\n') + await readFile(storePath, 'utf8');
    for (const note of store.notes) {
      for (const value of Object.values(deriveNoteSecrets(agentSeed, note.secretIndex))) {
        assert.ok(!observed.includes(value.toString()), 'Raw note material must remain local');
        assert.ok(!observed.toLowerCase().includes(value.toString(16).padStart(64, '0')), 'Raw note material must remain local');
      }
    }
    for (const seed of [operator, walletSeed, agentSeed]) assert.ok(!observed.includes(Buffer.from(seed).toString('hex')));
  });
  await t.test('E2E-04: close waits for an in-flight relayer request', async () => {
    const quote = node.relayer.quote.bind(node.relayer);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const pending = t.mock.method(node.relayer, 'quote', async (...args: Parameters<typeof quote>) => {
      arrived();
      await gate;
      return quote(...args);
    });
    const request = new RelayerClient(node.urls.relayer).quote([{ address: seller, amount: price, datumHash: null }]);
    // Attach a handler immediately so a broken shutdown is reported as a test failure.
    const outcome = request.then(value => ({ value }), error => ({ error }));
    await ready;
    let closed = false;
    const closing = node.close().then(() => { closed = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(closed, false, 'Shutdown must drain an accepted relayer request');
    } finally { release(); }
    await closing;
    pending.mock.restore();
    const result = await outcome;
    assert.ok('value' in result);
    assert.equal(result.value.poolId, deployment.poolId);
  });
  await t.test('E2E-04: concurrent ticks share one round and close stops caller-driven work', async () => {
    const live = await startNode(nodeOptions);
    t.after(() => live.close());
    const sync = live.indexer.sync.bind(live.indexer);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const pending = t.mock.method(live.indexer, 'sync', async () => { calls++; await gate; return sync(); });
    const one = live.tick();
    const two = live.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await Promise.all([one, two]);
    assert.equal(calls, 3);
    pending.mock.restore();
    await live.close();
    await live.close();
    const tip = t.mock.method(chain, 'getTip');
    await live.tick();
    assert.equal(tip.mock.callCount(), 0);
    await assert.rejects(fetch(`${live.urls.indexer}/v1/pool`));
    await assert.rejects(fetch(`${live.urls.relayer}/v1/pool`));
  });
  await t.test('E2E-04: timer rounds stop after close and wait for a running sync', async () => {
    const timed = await startNode({ ...nodeOptions, intervalMs: 10 });
    t.after(() => timed.close());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const sync = timed.indexer.sync.bind(timed.indexer);
    let calls = 0;
    t.mock.method(timed.indexer, 'sync', async () => { calls++; arrived(); await gate; return sync(); });
    await ready;
    let closed = false;
    const closing = timed.close().then(() => { closed = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(calls, 1);
      assert.equal(closed, false);
    } finally { release(); }
    await closing;
    const afterClose = calls;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, afterClose);
  });
  await t.test('E2E-04: artifact selection matches deployment keys and rejects altered files', async () => {
    const { deploymentArtifacts } = await import('../src/node.js');
    const development = await deploymentArtifacts(deployment, root);
    assert.deepEqual(development.spendVkey, await loadDevVkey('spend', root));
    assert.deepEqual((await development.load('insert')).vkey, await loadDevVkey('insert', root));
    const fixtureRoot = join(directory, 'artifact-fixture');
    const publicDir = join(fixtureRoot, 'deployments/preprod/keys');
    const devDir = join(fixtureRoot, 'artifacts/dev');
    await Promise.all([publicDir, devDir].map(path => mkdir(path, { recursive: true })));
    await writeFile(join(devDir, 'manifest.json'), await readFile(join(root, 'artifacts/dev/manifest.json')));
    const record = structuredClone(deployment);
    const manifest: Record<string, { vkey_sha256: string }> = {};
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    for (const name of ['spend', 'insert', 'ragequit'] as const) {
      const original = await readFile(join(root, `artifacts/dev/${name}_vkey.json`));
      await writeFile(join(devDir, `${name}_vkey.json`), original);
      const key = JSON.parse(original.toString('utf8'));
      if (name === 'spend') key.vk_alpha_1 = key.IC[0];
      record.vkeys[name] = vkToHex(vkToCardano(key));
      const bytes = Buffer.from(JSON.stringify(key));
      await writeFile(join(publicDir, `${name}_vkey.json`), bytes);
      manifest[name] = { vkey_sha256: sha(bytes) };
    }
    await writeFile(join(publicDir, 'manifest.json'), JSON.stringify({ circuits: manifest }));
    const production = await deploymentArtifacts(record, fixtureRoot);
    assert.deepEqual(vkToHex(vkToCardano(production.spendVkey)), record.vkeys.spend);
    const mismatched = structuredClone(record);
    mismatched.vkeys.ragequit = record.vkeys.insert;
    await assert.rejects(deploymentArtifacts(mismatched, fixtureRoot), /do not match the deployment/);
    await writeFile(join(publicDir, 'spend_vkey.json'), '{}');
    await assert.rejects(deploymentArtifacts(record, fixtureRoot), /Verification key hash mismatch/);
  });
  for (const [index, { view, inputs }] of transactions.entries()) {
    const poolInput = inputs.find(input => input.address === deployment.scripts.pool.address);
    const action = poolInput ? decodePoolRedeemer(view.redeemers.find(r => r.tag === 'spend'
      && view.inputs[r.index]?.txId === poolInput.ref.txId && view.inputs[r.index]?.index === poolInput.ref.index)!.dataCbor).kind
      : view.outputs.some(out => out.address === deployment.scripts.deposit.address) ? 'Deposit'
      : view.outputs.some(out => out.address === seller) ? 'Payment'
      : inputs.some(input => input.address === deployment.scripts.asp.address) ? 'ASP'
      : index === 0 ? 'Funding' : view.txId === deployment.initTx ? 'Init' : 'References';
    t.diagnostic(`TX ${JSON.stringify({ index: index + 1, action, id: view.txId, size: view.size,
      fee: String(view.fee), mem: String(view.redeemers.reduce((sum, r) => sum + r.mem, 0n)),
      steps: String(view.redeemers.reduce((sum, r) => sum + r.steps, 0n)) })}`);
  }
});
