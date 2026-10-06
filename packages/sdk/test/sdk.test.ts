import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, type DepositView, type ErrorCode, type IndexerApi, type RelayerApi, type SettleRequest } from '@zbase-cardano/api';
import { commitment, deriveNoteSecrets, deriveOneTimeKey, MerkleTree, NETWORKS, nullifierHash, precommitment, type Note } from '@zbase-cardano/crypto';
import { devKeysPresent, loadDevArtifacts, loadDevVkey, shutdown } from '@zbase-cardano/prover';
import { buildDeposit, decodeDepositDatum, decodeTx, enterpriseAddress, keyHash, signTx, slotToTime, stealthFee, timeToSlot,
  type Provider } from '@zbase-cardano/txlib';
import { startDevnet } from '@zbase-cardano/txlib/testing/devnet';
import { Indexer } from '@zbase-cardano/indexer';
import { AspService } from '@zbase-cardano/asp';
import { Crank } from '@zbase-cardano/crank';
import { Relayer } from '@zbase-cardano/relayer';
import * as sdkModule from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
after(shutdown);

function droppingProvider(provider: Provider, dropped: string[]): Provider {
  return {
    getTip: () => provider.getTip(),
    getProtocolParameters: () => provider.getProtocolParameters(),
    getUtxos: refs => provider.getUtxos(refs),
    getUtxosAt: address => provider.getUtxosAt(address),
    evaluate: (cbor, additional) => provider.evaluate(cbor, additional),
    submit: async cbor => { dropped.push(cbor); return decodeTx(cbor).txId; },
  };
}

async function reuseGuardHarness() {
  const { chain, ctx, keys } = await startDevnet();
  chain.advanceSlots(NETWORKS[ctx.deployment.network].zeroSlot);
  let asp: AspService;
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: () => asp.leaves() });
  asp = new AspService({ ctx, indexer, payerSeed: keys.operator, operatorSeeds: [keys.asp] });
  await indexer.sync();
  const artifacts = { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) };
  const crank = new Crank({ ctx, indexer, seed: keys.crank, artifacts: await loadDevArtifacts('insert', root) });
  let now = (await chain.getTip()).time;
  const relayer = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
    now: () => now, retryDelayMs: 1 });
  async function confirm() {
    chain.mineBlock();
    await indexer.sync();
    now = (await chain.getTip()).time;
  }
  async function advance() {
    await confirm();
    await crank.tick();
    await confirm();
    await asp.tick();
    await confirm();
  }
  const options = { seed: new Uint8Array(32).fill(151), ctx, indexer, relayer, artifacts,
    poll: { intervalMs: 1, timeoutMs: 600_000, onPoll: advance } };
  return { chain, options, confirm, walletSeed: keys.users[0]!, seller: enterpriseAddress(keys.users[1]!, ctx.deployment.network) };
}

test('SDK-02: a deposit from an empty store never reuses a secret the pool has seen', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { options, confirm, walletSeed } = await reuseGuardHarness();
  const original = sdkModule.createZbaseCardano(options);
  const first = await original.deposit({ amount: 12_000_000n, walletSeed });
  const note = await original.waitForNote(first.prepared.noteId);
  await original.ragequit({ noteId: note.id, refundSeed: walletSeed });
  await confirm();
  assert.ok((await options.indexer.getNullifiers(0, 1000)).nullifiers.includes(
    nullifierHash(deriveNoteSecrets(options.seed, note.secretIndex).nullifier)));

  const methods = ['getPool', 'getLeaves', 'getAspLeaves', 'getNullifiers', 'getDeposits'] as const;
  const calls = methods.map(name => t.mock.method(options.indexer, name));
  const store = sdkModule.memoryStore();
  const recovered = sdkModule.createZbaseCardano({ ...options, store });
  const second = await recovered.deposit({ amount: 12_000_000n, walletSeed });
  t.diagnostic(`Indexer calls during deposit: ${calls.reduce((sum, call) => sum + call.mock.callCount(), 0)}`);
  assert.notEqual(second.prepared.precommitment, first.prepared.precommitment);
  assert.equal((await store.load())!.nextDepositIndex, 2);
  assert.equal(calls[0]!.mock.callCount(), 1, 'Deposit must sync exactly once');
  assert.equal(calls.reduce((sum, call) => sum + call.mock.callCount(), 0), 7);
  assert.equal((await recovered.waitForNote(second.prepared.noteId)).status, 'spendable');
});

test('SDK-03: a change note from an empty store never reuses a spent secret', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async () => {
  const { options, confirm, walletSeed, seller } = await reuseGuardHarness();
  const payouts = [{ address: seller, amount: 2_000_000n }];
  const original = sdkModule.createZbaseCardano(options);
  const first = await original.deposit({ amount: 12_000_000n, walletSeed });
  await original.waitForNote(first.prepared.noteId);
  const firstReceipt = await original.settlePrivately({ payouts });
  assert.ok(firstReceipt.changeNoteId);
  const firstChange = await original.waitForNote(firstReceipt.changeNoteId);
  assert.equal(firstChange.secretIndex, 2 ** 20);
  await original.ragequit({ noteId: firstChange.id, refundSeed: walletSeed });
  await confirm();
  assert.ok((await options.indexer.getNullifiers(0, 1000)).nullifiers.includes(
    nullifierHash(deriveNoteSecrets(options.seed, firstChange.secretIndex).nullifier)));

  const store = sdkModule.memoryStore();
  const recovered = sdkModule.createZbaseCardano({ ...options, store });
  await recovered.sync();
  const second = await recovered.deposit({ amount: 12_000_000n, walletSeed });
  await recovered.waitForNote(second.prepared.noteId);
  const secondReceipt = await recovered.settlePrivately({ payouts });
  assert.ok(secondReceipt.changeNoteId);
  const secondChange = recovered.listNotes().find(n => n.id === secondReceipt.changeNoteId)!;
  assert.notEqual(secondChange.precommitment, firstChange.precommitment);
  assert.equal(secondChange.secretIndex, 2 ** 20 + 1);
  assert.equal((await store.load())!.nextChangeIndex, 2);
  assert.equal((await recovered.waitForNote(secondChange.id)).status, 'spendable');
  await recovered.ragequit({ noteId: secondChange.id, refundSeed: walletSeed });
  await confirm();
  await recovered.sync();
  const exited = recovered.listNotes().find(n => n.id === secondChange.id)!;
  assert.equal(exited.status, 'exited');
  assert.equal(exited.pending, undefined);
});

test('SDK-01: preparation after a sync skips a precommitment that is already on chain', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { chain, options, confirm, walletSeed } = await reuseGuardHarness();
  const refundKeyHash = hex(keyHash(walletSeed));
  const store = sdkModule.memoryStore();
  const original = sdkModule.createZbaseCardano({ ...options, store });
  await original.prepareDeposit({ amount: 12_000_000n, refundKeyHash });
  const backup = (await store.load())!;
  assert.equal(backup.notes.length, 1);
  assert.equal(backup.nextDepositIndex, 1);
  const absorbed = await original.deposit({ amount: 12_000_000n, walletSeed });
  await original.waitForNote(absorbed.prepared.noteId);
  const refunded = await original.deposit({ amount: 12_000_000n, walletSeed });
  await confirm();
  await original.refund({ noteId: refunded.prepared.noteId, refundSeed: walletSeed });
  await confirm();
  const pending = await original.deposit({ amount: 12_000_000n, walletSeed });
  await confirm();
  const deposits = await options.indexer.getDeposits();
  for (const [deposit, status] of [[absorbed, 'absorbed'], [refunded, 'refunded'], [pending, 'pending']] as const) {
    assert.equal(deposits.find(d => d.txId === deposit.txId)!.status, status);
  }

  const restored = sdkModule.memoryStore();
  await restored.save(backup);
  const recovered = sdkModule.createZbaseCardano({ ...options, store: restored });
  await recovered.sync();
  const indexerMethods = ['getPool', 'getLeaves', 'getAspLeaves', 'getNullifiers', 'getDeposits'] as const;
  const providerMethods = ['getTip', 'getProtocolParameters', 'getUtxos', 'getUtxosAt', 'evaluate', 'submit'] as const;
  const calls = [...indexerMethods.map(name => t.mock.method(options.indexer, name)),
    ...providerMethods.map(name => t.mock.method(chain, name))];
  const prepared = await recovered.prepareDeposit({ amount: 12_000_000n, refundKeyHash });
  assert.notEqual(prepared.precommitment, absorbed.prepared.precommitment);
  assert.ok(deposits.every(d => d.precommitment !== prepared.precommitment));
  assert.equal(prepared.noteId, 'd4');
  assert.equal((await restored.load())!.nextDepositIndex, 5);
  assert.equal(calls.reduce((sum, call) => sum + call.mock.callCount(), 0), 0);
});

test('SDK-01 through SDK-08: local agent story with real validators and proofs', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  assert.equal(typeof sdkModule.createZbaseCardano, 'function', 'The SDK must expose createZbaseCardano');
  const { createZbaseCardano, fileStore, memoryStore } = sdkModule;
  const { chain, ctx, keys } = await startDevnet();
  const network = ctx.deployment.network;
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const seed = new Uint8Array(32).fill(91);
  const walletSeed = keys.users[0]!;
  const wallet = enterpriseAddress(walletSeed, network);
  const refundKeyHash = hex(keyHash(walletSeed));
  const seller = enterpriseAddress(new Uint8Array(32).fill(92), network);
  const stealthSellers = [93, 94].map(n => enterpriseAddress(new Uint8Array(32).fill(n), network));
  const denied = new Set<string>();
  let asp: AspService;
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: () => asp.leaves() });
  asp = new AspService({ ctx, indexer, payerSeed: keys.operator, operatorSeeds: [keys.asp],
    deny: deposit => denied.has(deposit.txId) });
  await indexer.sync();
  const artifacts = { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) };
  const crank = new Crank({ ctx, indexer, seed: keys.crank, artifacts: await loadDevArtifacts('insert', root) });
  let now = (await chain.getTip()).time;
  const relayer = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
    now: () => now, retryDelayMs: 1 });
  const calls: { method: string; args: unknown[] }[] = [];
  let staleAsp = false;
  let corrupt = false;
  const observed: IndexerApi = {
    getPool: () => { calls.push({ method: 'getPool', args: [] }); return indexer.getPool(); },
    getLeaves: async (from, limit) => {
      calls.push({ method: 'getLeaves', args: [from, limit] });
      const page = await indexer.getLeaves(from, Math.min(1, limit));
      if (corrupt && from === 0 && page.leaves.length) page.leaves[0] = 1n;
      return page;
    },
    getAspLeaves: (from, limit) => {
      calls.push({ method: 'getAspLeaves', args: [from, limit] });
      if (staleAsp) return Promise.reject(new ApiError('stale_asp_root', 'Association update is pending'));
      return indexer.getAspLeaves(from, Math.min(1, limit));
    },
    getDeposits: fromSlot => { calls.push({ method: 'getDeposits', args: fromSlot === undefined ? [] : [fromSlot] }); return indexer.getDeposits(fromSlot); },
    getNullifiers: (from, limit) => {
      calls.push({ method: 'getNullifiers', args: [from, limit] });
      return indexer.getNullifiers(from, Math.min(1, limit));
    },
  };
  const requests: SettleRequest[] = [];
  let failures: ErrorCode[] = [];
  let quotes = 0;
  const relay: RelayerApi = {
    getPool: () => relayer.getPool(),
    quote: payouts => { quotes++; return relayer.quote(payouts); },
    settle: request => {
      requests.push(structuredClone(request));
      const failure = failures.shift();
      if (failure) return Promise.reject(new ApiError(failure, 'Injected chain race'));
      return relayer.settle(request);
    },
    getSettle: id => relayer.getSettle(id),
  };
  let rounds = 0;
  async function advance() {
    rounds++;
    now = (await chain.getTip()).time;
    chain.mineBlock();
    await indexer.sync();
    await crank.tick();
    chain.mineBlock();
    await indexer.sync();
    await asp.tick();
    chain.mineBlock();
    await indexer.sync();
  }
  const store = memoryStore();
  const options = { seed, ctx, indexer: observed, relayer: relay, artifacts,
    poll: { intervalMs: 1, timeoutMs: 600_000, onPoll: advance } };
  const sdk = createZbaseCardano({ ...options, store });
  let noteId = '';
  let changeId = '';
  const note = (id: string) => {
    const record = sdk.listNotes().find(n => n.id === id);
    assert.ok(record, `Missing note ${id}`);
    return record;
  };
  async function step(name: string, body: () => Promise<void>) {
    await t.test(name, async st => {
      const started = performance.now();
      try { await body(); }
      finally { st.diagnostic(`Story duration: ${((performance.now() - started) / 1000).toFixed(3)} seconds`); }
    });
  }

  await step('SDK-01: preparation is deterministic, offline, and uses distinct indexes', async () => {
    const offline = createZbaseCardano(options);
    const before = calls.length;
    const first = await offline.prepareDeposit({ amount: 20_000_000n, refundKeyHash });
    const second = await offline.prepareDeposit({ amount: 20_000_000n, refundKeyHash });
    const fresh = await createZbaseCardano(options).prepareDeposit({ amount: 20_000_000n, refundKeyHash });
    assert.equal(calls.length, before);
    assert.equal(first.address, ctx.deployment.scripts.deposit.address);
    assert.equal(first.amount, 20_000_000n);
    assert.deepEqual(decodeDepositDatum(first.inlineDatum), { precommitment: first.precommitment, refund: refundKeyHash });
    assert.notEqual(first.precommitment, second.precommitment);
    assert.equal(first.precommitment, fresh.precommitment);
    assert.equal(offline.listNotes()[0]!.expectedRefundKeyHash, refundKeyHash);
  });
  await step('SDK-01: deposit and poll until the credited note is spendable', async () => {
    const deposit = await sdk.deposit({ amount: 20_000_000n, walletSeed });
    noteId = deposit.prepared.noteId;
    const value = await sdk.waitForNote(noteId);
    assert.equal(value.status, 'spendable');
    assert.equal(value.value, 19_700_000n);
    assert.equal(typeof value.label, 'bigint');
    assert.equal(typeof value.leafIndex, 'number');
    assert.deepEqual(sdk.balance(), { spendable: 19_700_000n, pending: 0n });
    assert.ok(rounds > 0);
  });
  await step('SDK-02: an empty store recovers the deposit from the seed', async () => {
    const recovered = createZbaseCardano(options);
    await recovered.sync();
    assert.deepEqual(recovered.listNotes(), sdk.listNotes().map(n => ({ ...n, expectedRefundKeyHash: null })));
    const next = await recovered.prepareDeposit({ amount: 10_000_000n, refundKeyHash });
    assert.equal(next.noteId, 'd1');
  });
  await step('SDK-03: private settlement pays exactly and inserts the queued change', async () => {
    const oldValue = note(noteId).value!;
    const receipt = await sdk.settlePrivately({ payouts: [{ address: seller, amount: 3_000_000n }] });
    assert.equal(note(noteId).status, 'spent');
    assert.equal(note(noteId).pending?.kind, 'settle');
    assert.ok(receipt.changeNoteId);
    changeId = receipt.changeNoteId;
    assert.equal(note(changeId).status, 'queued');
    assert.equal((await sdk.waitForSettle(receipt.id)).status, 'confirmed');
    await sdk.waitForNote(changeId);
    assert.equal(note(noteId).pending, undefined);
    assert.deepEqual((await chain.getUtxosAt(seller)).map(u => u.value.lovelace), [3_000_000n]);
    assert.equal(sdk.balance().spendable, oldValue - receipt.withdrawn);
    assert.equal(note(changeId).secretIndex, 2 ** 20);
    assert.deepEqual(note(changeId).origin, note(noteId).origin);
  });
  await step('SDK-03: the relayer request contains no note or change secrets', async () => {
    const request = requests[0]!;
    assert.deepEqual(Object.keys(request).sort(), ['intent', 'proof', 'publicInputs', 'quoteId']);
    const encoded = json(request);
    for (const id of [noteId, changeId]) {
      const secrets = deriveNoteSecrets(seed, note(id).secretIndex);
      for (const value of Object.values(secrets)) assert.ok(!encoded.includes(value.toString()), 'Private material leaked');
    }
    for (const key of ['secret', 'leafIndex', 'noteValue']) assert.ok(!encoded.includes(`"${key}"`));
  });
  for (const i of [0, 1]) {
    await step(`SDK-04: stealth payment ${i + 1} uses a fresh one-time input and an exact seller output`, async () => {
      const signer = sdk.x402Signer();
      const address = signer.getAddress();
      const signed = await signer.buildAndSignPaymentTransaction({ network: `cardano:${network}`, asset: 'lovelace',
        payTo: stealthSellers[i]!, amount: '2000000', maxTimeoutSeconds: 300 });
      const cbor = Buffer.from(signed.transaction, 'base64').toString('hex');
      const view = decodeTx(cbor);
      assert.equal(view.inputs.length, 1);
      assert.equal(signed.nonce, `${view.inputs[0]!.txId}#${view.inputs[0]!.index}`);
      const funding = await chain.getUtxos(view.inputs);
      assert.equal(funding[0]!.address, address);
      assert.notEqual(address, wallet);
      assert.notEqual(signer.getAddress(), address);
      assert.equal(view.outputs.length, 1);
      assert.equal(view.outputs[0]!.address, stealthSellers[i]);
      assert.equal(view.outputs[0]!.value.lovelace, 2_000_000n);
      assert.ok(view.outputs.every(o => o.address !== wallet));
      assert.ok(view.invalidHereafter! < (await chain.getTip()).slot + 300);
      assert.equal(view.redeemers.length, 0);
      await chain.submit(cbor);
      chain.mineBlock();
      assert.deepEqual((await chain.getUtxosAt(stealthSellers[i]!)).map(u => u.value.lovelace), [2_000_000n]);
      await sdk.sync();
    });
  }
  await step('SDK-05: a denied note cannot settle but can exit to the refund key', async () => {
    const deposited = await sdk.deposit({ amount: 10_000_000n, walletSeed });
    denied.add(deposited.txId);
    await advance();
    await sdk.sync();
    const id = deposited.prepared.noteId;
    assert.equal(note(id).status, 'inserted');
    await assert.rejects(sdk.settlePrivately({ noteId: id, payouts: [{ address: seller, amount: 2_000_000n }] }), /not spendable/i);
    const balance = async () => (await chain.getUtxosAt(wallet)).reduce((sum, u) => sum + u.value.lovelace, 0n);
    const before = await balance();
    const result = await sdk.ragequit({ noteId: id, refundSeed: walletSeed });
    assert.equal(note(id).pending?.kind, 'exit');
    chain.mineBlock();
    await indexer.sync();
    await sdk.sync();
    const tx = decodeTx(await chain.getTransactionCbor(result.txId));
    assert.equal(await balance() - before, 9_700_000n - tx.fee);
    assert.equal(note(id).status, 'exited');
    assert.equal(note(id).pending, undefined);
  });
  await step('SDK-06: a pending deposit can be refunded before a crank round', async () => {
    const deposited = await sdk.deposit({ amount: 10_000_000n, walletSeed });
    chain.mineBlock();
    await indexer.sync();
    await sdk.sync();
    assert.equal(note(deposited.prepared.noteId).status, 'deposited');
    await sdk.refund({ noteId: deposited.prepared.noteId, refundSeed: walletSeed });
    assert.equal(note(deposited.prepared.noteId).pending?.kind, 'refund');
    chain.mineBlock();
    await indexer.sync();
    await sdk.sync();
    assert.equal(note(deposited.prepared.noteId).status, 'refunded');
    assert.equal(note(deposited.prepared.noteId).pending, undefined);
    await assert.rejects(sdk.waitForNote(deposited.prepared.noteId), /refunded/i);
  });
  await step('SDK-07: unavailable and excessive payments fail clearly before proving', async () => {
    const empty = createZbaseCardano({ ...options, seed: new Uint8Array(32).fill(99) });
    await assert.rejects(empty.settlePrivately({ payouts: [{ address: seller, amount: 2_000_000n }] }), /no spendable note/i);
    await assert.rejects(sdk.settlePrivately({ payouts: [{ address: seller, amount: 100_000_000n }] }), /amount|balance|cover|value/i);
    await assert.rejects(sdk.settlePrivately({ payouts: [{ address: seller, amount: 1n }] }), /minimum|lovelace/i);
  });
  await step('SDK-08: sync uses only list queries and downloads short pages completely', async () => {
    calls.length = 0;
    await sdk.sync();
    const privateValues = sdk.listNotes().flatMap(n => {
      const secrets = deriveNoteSecrets(seed, n.secretIndex);
      return [n.label, nullifierHash(secrets.nullifier), n.value === null || n.label === null ? null
        : commitment({ ...secrets, value: n.value, label: n.label } satisfies Note)];
    }).filter(v => v !== null).map(String);
    for (const call of calls) {
      assert.ok(['getPool', 'getLeaves', 'getAspLeaves', 'getDeposits', 'getNullifiers'].includes(call.method));
      for (const arg of call.args) assert.ok(!privateValues.includes(String(arg)));
    }
    assert.ok(calls.some(c => c.method === 'getLeaves' && Number(c.args[0]) > 0));
    assert.ok(calls.some(c => c.method === 'getNullifiers' && Number(c.args[0]) > 0));
  });
  await step('SDK-02: an inconsistent commitment fails without publishing partial state', async () => {
    const before = sdk.listNotes();
    corrupt = true;
    try { await assert.rejects(sdk.sync(), /tree|commitment|root/i); }
    finally { corrupt = false; }
    assert.deepEqual(sdk.listNotes(), before);
  });
  await step('SDK-06: stale association data does not promote recovered notes or break sync', async () => {
    staleAsp = true;
    try {
      await sdk.sync();
      const recovered = createZbaseCardano(options);
      await recovered.sync();
      assert.ok(recovered.listNotes().every(n => n.status !== 'spendable'));
    } finally { staleAsp = false; }
    await sdk.sync();
  });
  await step('SDK-06: stale roots trigger fresh quotes and proofs, with three total attempts', async () => {
    failures = ['stale_root', 'stale_asp_root', 'internal'];
    const before = requests.length;
    const beforeQuotes = quotes;
    await assert.rejects(sdk.settlePrivately({ payouts: [{ address: seller, amount: 1_000_000n }] }), (e: unknown) =>
      e instanceof ApiError && e.code === 'internal');
    assert.equal(requests.length - before, 3);
    assert.equal(quotes - beforeQuotes, 3);
    assert.equal(new Set(requests.slice(before).map(r => r.quoteId)).size, 3);
    assert.equal(new Set(requests.slice(before).map(r => r.proof.a)).size, 3);
    failures = ['queue_full'];
    const previous = requests.length;
    await assert.rejects(sdk.settlePrivately({ payouts: [{ address: seller, amount: 1_000_000n }] }), (e: unknown) =>
      e instanceof ApiError && e.code === 'queue_full');
    assert.equal(requests.length - previous, 1);
  });
  await step('SDK-01: waiting polls until timeout and propagates a failed settlement', async () => {
    let polls = 0;
    const waiting = createZbaseCardano({ ...options, seed: new Uint8Array(32).fill(103),
      poll: { intervalMs: 1, timeoutMs: 20, onPoll: () => { polls++; } },
      relayer: { ...relay, getSettle: async id => ({ id, status: 'failed', txHash: '00'.repeat(32),
        confirmations: 0, error: 'Rejected payment' }) } });
    const prepared = await waiting.prepareDeposit({ amount: 10_000_000n, refundKeyHash });
    await assert.rejects(waiting.waitForNote(prepared.noteId), /timed out/i);
    assert.ok(polls > 0);
    await assert.rejects(waiting.waitForSettle('failed-payment'), /failed.*Rejected payment/i);
  });
  await step('SDK-04: wrong networks, assets, and timeouts never start a private payment', async () => {
    const signer = sdk.x402Signer();
    const input = { network: `cardano:${network}`, asset: 'lovelace', payTo: seller,
      amount: '2000000', maxTimeoutSeconds: 300 };
    const before = requests.length;
    await assert.rejects(async () => signer.buildAndSignPaymentTransaction({ ...input, network: 'cardano:mainnet' }), /network/i);
    await assert.rejects(async () => signer.buildAndSignPaymentTransaction({ ...input, asset: 'token' }), /lovelace/i);
    await assert.rejects(async () => signer.buildAndSignPaymentTransaction({ ...input, maxTimeoutSeconds: 1 }), /timeout/i);
    assert.equal(requests.length, before);
  });
  await step('SDK-01: file store round trip preserves counters without private material', async () => {
    const build = fileURLToPath(new URL('../build/', import.meta.url));
    await mkdir(build, { recursive: true });
    const path = join(build, `sdk-test-${randomUUID()}.json`);
    t.after(async () => { await unlink(path).catch(() => undefined); });
    const file = fileStore(path);
    assert.equal(await file.load(), null);
    const saved = await store.load();
    assert.ok(saved);
    await file.save(saved);
    assert.deepEqual(await fileStore(path).load(), saved);
    const text = await readFile(path, 'utf8');
    for (const n of saved.notes) {
      for (const value of Object.values(deriveNoteSecrets(seed, n.secretIndex))) assert.ok(!text.includes(value.toString()));
    }
    const resumed = createZbaseCardano({ ...options, store: fileStore(path) });
    await resumed.sync();
    assert.deepEqual(resumed.listNotes(), sdk.listNotes());
    assert.equal(resumed.x402Signer().getAddress(), sdk.x402Signer().getAddress());
    const copied = resumed.listNotes();
    copied[0]!.status = 'created';
    assert.notEqual(resumed.listNotes()[0]!.status, 'created');
  });
  await step('SDK-04: failed confirmation names the funded key and preserves its next counter', async () => {
    let polls = 0;
    const before = (await store.load())!;
    const waiting = createZbaseCardano({ ...options, store,
      poll: { intervalMs: 1, timeoutMs: 20, onPoll: () => { polls++; } } });
    await waiting.sync();
    const signer = waiting.x402Signer();
    const address = signer.getAddress();
    await assert.rejects(async () => signer.buildAndSignPaymentTransaction({ network: `cardano:${network}`, asset: 'lovelace',
      payTo: seller, amount: '2000000', maxTimeoutSeconds: 300 }),
    new RegExp(`one-time key index ${before.nextOneTimeIndex}`));
    assert.ok(polls > 0);
    assert.equal((await store.load())!.nextOneTimeIndex, before.nextOneTimeIndex + 1);
    assert.notEqual(signer.getAddress(), address);
    await advance();
    assert.equal((await chain.getUtxosAt(address)).length, 1);
  });
});


test('SDK-03: quotes contain only public payout fields', {
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async () => {
  const { ctx, chain } = await startDevnet();
  const indexer = new Indexer({ ctx, history: chain });
  await indexer.sync();
  const pool = await indexer.getPool();
  const seed = new Uint8Array(32).fill(101);
  const secrets = deriveNoteSecrets(seed, 0);
  const tree = MerkleTree.fromLeaves([commitment({ ...secrets, value: 10_000_000n, label: 42n })]);
  const approved = MerkleTree.fromLeaves([42n]);
  const store = sdkModule.memoryStore();
  await store.save({ nextDepositIndex: 1, nextChangeIndex: 0, nextOneTimeIndex: 0, notes: [{
    id: 'd0', kind: 'deposit', secretIndex: 0, status: 'spendable', value: 10_000_000n,
    label: 42n, leafIndex: 0, origin: null, gross: 10_000_000n,
    precommitment: precommitment(secrets.nullifier, secrets.secret),
  }] });
  const snapshot: IndexerApi = {
    getPool: async () => ({ ...pool, size: 1, roots: [tree.root], aspRoot: approved.root }),
    getLeaves: async from => ({ from, size: 1, root: tree.root, leaves: from === 0 ? [tree.leaf(0)] : [] }),
    getAspLeaves: async from => ({ from, root: approved.root, leaves: from === 0 ? [42n] : [] }),
    getDeposits: async () => [],
    getNullifiers: async from => ({ from, nullifiers: [] }),
  };
  let fields: string[] = [];
  const stop = new Error('Stop at the outbound quote boundary');
  const relay: RelayerApi = {
    getPool: snapshot.getPool,
    quote: async payouts => { fields = Object.keys(payouts[0]!).sort(); throw stop; },
    settle: async () => { throw new Error('This test must stop before proving'); },
    getSettle: async () => { throw new Error('This test must stop before submitting'); },
  };
  const sdk = sdkModule.createZbaseCardano({ seed, ctx, store, indexer: snapshot, relayer: relay,
    artifacts: { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) } });
  const payout = { address: enterpriseAddress(new Uint8Array(32).fill(102), ctx.deployment.network),
    amount: 2_000_000n, secret: secrets.secret, leafIndex: 0 };
  await assert.rejects(sdk.settlePrivately({ payouts: [payout] }), error => error === stop);
  assert.deepEqual(fields, ['address', 'amount', 'datumHash']);
});

test('SDK-01, SDK-03, SDK-04, SDK-08: hardening against dropped submissions and copied precommitments', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { chain, ctx, keys } = await startDevnet();
  const network = ctx.deployment.network;
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const walletSeed = keys.users[0]!;
  const wallet = enterpriseAddress(walletSeed, network);
  const refundKeyHash = hex(keyHash(walletSeed));
  const seller = enterpriseAddress(keys.users[2]!, network);
  let asp: AspService;
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: () => asp.leaves() });
  asp = new AspService({ ctx, indexer, payerSeed: keys.operator, operatorSeeds: [keys.asp] });
  await indexer.sync();
  const artifacts = { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) };
  const crank = new Crank({ ctx, indexer, seed: keys.crank, artifacts: await loadDevArtifacts('insert', root) });
  let now = (await chain.getTip()).time;
  const makeRelayer = (provider: Provider = chain) => new Relayer({ ctx: { ...ctx, provider }, indexer,
    seed: keys.relayer, vkey: artifacts.spend.vkey, now: () => now, retryDelayMs: 1 });
  async function advance() {
    chain.mineBlock();
    await indexer.sync();
    await crank.tick();
    chain.mineBlock();
    await indexer.sync();
    await asp.tick();
    chain.mineBlock();
    await indexer.sync();
    now = (await chain.getTip()).time;
  }
  async function reach(time: number) {
    const slot = timeToSlot(time, network);
    chain.mineBlock(slot - (await chain.getTip()).slot);
    now = (await chain.getTip()).time;
    await indexer.sync();
  }
  const options = { ctx, indexer, artifacts, poll: { intervalMs: 1, timeoutMs: 600_000, onPoll: advance } };
  const payouts = [{ address: seller, amount: 2_000_000n }];

  await t.test('SDK-03: a dropped settle stays pending through the margin, then recovers and can pay again', async () => {
    const seed = new Uint8Array(32).fill(111);
    const store = sdkModule.memoryStore();
    const dropped: string[] = [];
    const drop = makeRelayer(droppingProvider(chain, dropped));
    const sdk = sdkModule.createZbaseCardano({ ...options, seed, store, relayer: drop });
    const deposited = await sdk.deposit({ amount: 12_000_000n, walletSeed });
    await sdk.waitForNote(deposited.prepared.noteId);
    const receipt = await sdk.settlePrivately({ payouts });
    const original = sdk.listNotes().find(n => n.id === receipt.noteId)!;
    assert.equal(original.status, 'spent');
    assert.deepEqual(original.pending, { kind: 'settle', changeNoteId: receipt.changeNoteId,
      validUntil: slotToTime(decodeTx(dropped[0]!).invalidHereafter!, network) });
    assert.equal(sdk.balance().spendable, 0n);
    await sdk.sync();
    assert.deepEqual(sdk.listNotes().find(n => n.id === receipt.noteId), original);
    await assert.rejects(sdk.settlePrivately({ payouts, noteId: receipt.noteId }), /not spendable/i);
    const resumed = sdkModule.createZbaseCardano({ ...options, seed, store, relayer: makeRelayer() });
    await reach(original.pending!.validUntil + 120_000);
    await resumed.sync();
    assert.equal(resumed.listNotes().find(n => n.id === receipt.noteId)!.status, 'spent');
    await reach(original.pending!.validUntil + 121_000);
    await resumed.sync();
    assert.equal(resumed.listNotes().length, 1);
    assert.equal(resumed.listNotes()[0]!.status, 'spendable');
    assert.equal(resumed.listNotes()[0]!.pending, undefined);
    assert.equal(resumed.balance().spendable, 11_700_000n);
    const paid = await resumed.settlePrivately({ payouts, noteId: receipt.noteId });
    await advance();
    await resumed.sync();
    assert.equal(resumed.listNotes().find(n => n.id === receipt.noteId)!.pending, undefined);
    assert.equal(resumed.listNotes().find(n => n.id === receipt.noteId)!.status, 'spent');
    assert.ok((await chain.getUtxosAt(seller)).some(u => u.ref.txId === paid.txHash));
  });

  for (const kind of ['exit', 'refund'] as const) {
    await t.test(`SDK-01: a dropped ${kind} has an expiry and returns to its confirmed status`, async () => {
      const seed = new Uint8Array(32).fill(kind === 'exit' ? 112 : 113);
      const store = sdkModule.memoryStore();
      const relayer = makeRelayer();
      const sdk = sdkModule.createZbaseCardano({ ...options, seed, store, relayer });
      const deposited = await sdk.deposit({ amount: 12_000_000n, walletSeed });
      const id = deposited.prepared.noteId;
      if (kind === 'exit') await sdk.waitForNote(id);
      else { chain.mineBlock(); await indexer.sync(); await sdk.sync(); }
      const dropped: string[] = [];
      const dropping = sdkModule.createZbaseCardano({ ...options, seed, store, relayer,
        ctx: { ...ctx, provider: droppingProvider(chain, dropped) },
        ...(kind === 'exit' ? { exitValidForSlots: 60 } : {}) });
      const before = await chain.getTip();
      const args = { noteId: id, refundSeed: walletSeed };
      await (kind === 'exit' ? dropping.ragequit(args) : dropping.refund(args));
      const upper = before.slot + (kind === 'exit' ? 60 : 600);
      assert.equal(decodeTx(dropped[0]!).invalidHereafter, upper);
      const marked = dropping.listNotes()[0]!;
      assert.equal(marked.status, kind === 'exit' ? 'exited' : 'refunded');
      assert.deepEqual(marked.pending, { kind, validUntil: slotToTime(upper, network), changeNoteId: null });
      await dropping.sync();
      assert.deepEqual(dropping.listNotes()[0], marked);
      await reach(marked.pending!.validUntil + 120_000);
      await dropping.sync();
      assert.deepEqual(dropping.listNotes()[0], marked);
      await reach(marked.pending!.validUntil + 121_000);
      // Reload persisted pending metadata, as a restarted process would.
      const resumed = sdkModule.createZbaseCardano({ ...options, seed, store, relayer });
      await resumed.sync();
      assert.equal(resumed.listNotes()[0]!.status, kind === 'exit' ? 'spendable' : 'deposited');
      assert.equal(resumed.listNotes()[0]!.pending, undefined);
      await (kind === 'exit' ? resumed.ragequit(args) : resumed.refund(args));
      chain.mineBlock();
      await indexer.sync();
      await resumed.sync();
      assert.equal(resumed.listNotes()[0]!.status, kind === 'exit' ? 'exited' : 'refunded');
      assert.equal(resumed.listNotes()[0]!.pending, undefined);
    });
  }

  await t.test('SDK-08: a larger copied precommitment cannot replace the original refund key', async () => {
    const seed = new Uint8Array(32).fill(114);
    const sdk = sdkModule.createZbaseCardano({ ...options, seed, relayer: makeRelayer() });
    const prepared = await sdk.prepareDeposit({ amount: 12_000_000n, refundKeyHash });
    const attacker = keys.users[1]!;
    const copy = await buildDeposit(ctx, { payer: { address: enterpriseAddress(attacker, network) }, amount: 20_000_000n,
      precommitment: prepared.precommitment, refundKeyHash: hex(keyHash(attacker)) });
    await chain.submit(signTx(copy.cbor, [attacker]));
    const own = await buildDeposit(ctx, { payer: { address: wallet }, amount: prepared.amount,
      precommitment: prepared.precommitment, refundKeyHash });
    await chain.submit(signTx(own.cbor, [walletSeed]));
    await sdk.waitForNote(prepared.noteId);
    const actual = sdk.listNotes()[0]!;
    const deposit = (await indexer.getDeposits()).find(d => d.txId === own.txId)!;
    assert.deepEqual(actual.origin, { txId: own.txId, index: deposit.index, refundKeyHash });
    assert.equal(actual.value, 11_700_000n);
    assert.equal(actual.label, deposit.label);
    const receipt = await sdk.settlePrivately({ payouts, noteId: prepared.noteId });
    assert.ok(receipt.changeNoteId);
    await sdk.waitForNote(receipt.changeNoteId);
    await sdk.ragequit({ noteId: receipt.changeNoteId, refundSeed: walletSeed });
    chain.mineBlock();
    await indexer.sync();
    await sdk.sync();
    assert.equal(sdk.listNotes().find(n => n.id === receipt.changeNoteId)!.status, 'exited');
  });

  await t.test('SDK-04: a lost settlement response still reserves the funded key before a restart', async () => {
    const seed = new Uint8Array(32).fill(115);
    const store = sdkModule.memoryStore();
    const relayer = makeRelayer();
    const funded: string[] = [];
    let reserved = -1;
    let loseResponse = true;
    const wrapper: RelayerApi = {
      getPool: () => relayer.getPool(), quote: payouts => relayer.quote(payouts), getSettle: id => relayer.getSettle(id),
      settle: async request => {
        reserved = (await store.load())!.nextOneTimeIndex;
        const result = await relayer.settle(request);
        funded.push(request.intent.payouts[0]!.address);
        if (loseResponse) { loseResponse = false; throw new Error('Lost accepted settlement response'); }
        return result;
      },
    };
    const sdk = sdkModule.createZbaseCardano({ ...options, seed, store, relayer: wrapper });
    const first = await sdk.deposit({ amount: 12_000_000n, walletSeed });
    await sdk.waitForNote(first.prepared.noteId);
    const second = await sdk.deposit({ amount: 12_000_000n, walletSeed });
    await sdk.waitForNote(second.prepared.noteId);
    const input = { network: `cardano:${network}`, asset: 'lovelace', payTo: seller, amount: '2000000', maxTimeoutSeconds: 300 };
    await assert.rejects(async () => sdk.x402Signer().buildAndSignPaymentTransaction(input), /one-time key index 0/);
    assert.equal(reserved, 1);
    assert.equal((await store.load())!.nextOneTimeIndex, 1);
    await advance();
    assert.equal((await chain.getUtxosAt(funded[0]!)).length, 1);
    const resumed = sdkModule.createZbaseCardano({ ...options, seed, store, relayer: wrapper });
    await resumed.sync();
    await resumed.x402Signer().buildAndSignPaymentTransaction(input);
    assert.equal(reserved, 2);
    assert.notEqual(funded[1], funded[0]);
  });
});

test('SDK-03, SDK-04: hardening rejects untrusted fees and seller prices before proving or funding', async t => {
  const { chain, ctx, keys } = await startDevnet();
  const indexer = new Indexer({ ctx, history: chain });
  await indexer.sync();
  const pool = await indexer.getPool();
  const seed = new Uint8Array(32).fill(116);
  const secrets = deriveNoteSecrets(seed, 0);
  const tree = MerkleTree.fromLeaves([commitment({ ...secrets, value: 40_000_000n, label: 42n })]);
  const approved = MerkleTree.fromLeaves([42n]);
  const snapshot: IndexerApi = {
    getPool: async () => ({ ...pool, size: 1, roots: [tree.root], aspRoot: approved.root,
      config: { ...pool.config, settleFeeBps: 123 } }),
    getLeaves: async from => ({ from, size: 1, root: tree.root, leaves: from === 0 ? [tree.leaf(0)] : [] }),
    getAspLeaves: async from => ({ from, root: approved.root, leaves: from === 0 ? [42n] : [] }),
    getDeposits: async () => [], getNullifiers: async from => ({ from, nullifiers: [] }),
  };
  const relayer = new Relayer({ ctx, indexer: snapshot, seed: keys.relayer, vkey: await loadDevVkey('spend', root) });
  const store = sdkModule.memoryStore();
  await store.save({ nextDepositIndex: 1, nextChangeIndex: 0, nextOneTimeIndex: 0, notes: [{
    id: 'd0', kind: 'deposit', secretIndex: 0, status: 'spendable', value: 40_000_000n,
    label: 42n, leafIndex: 0, origin: null, gross: 40_000_000n, precommitment: precommitment(secrets.nullifier, secrets.secret),
  }] });
  let quotedFee = 1_000_000n;
  let protocolDelta = 0n;
  let quotes = 0;
  let submissions = 0;
  const wrapper: RelayerApi = {
    getPool: snapshot.getPool,
    quote: async payouts => {
      quotes++;
      const quote = await relayer.quote(payouts);
      return { ...quote, relayerFee: quotedFee, protocolFee: quote.protocolFee + protocolDelta,
        withdrawn: quote.withdrawn - quote.relayerFee + quotedFee + protocolDelta };
    },
    settle: async () => { submissions++; throw new Error('Unexpected settlement'); },
    getSettle: id => relayer.getSettle(id),
  };
  const proving = new Error('Proving started');
  const artifacts = { get spend(): never { throw proving; }, get ragequit(): never { throw proving; } };
  const options = { seed, ctx, indexer: snapshot, relayer: wrapper, store, artifacts };
  const seller = enterpriseAddress(keys.users[0]!, ctx.deployment.network);
  const payouts = [{ address: seller, amount: 2_000_001n }];
  await t.test('SDK-03: the default relayer fee limit rejects one lovelace over the cap', async () => {
    quotedFee = 2_000_001n;
    await assert.rejects(sdkModule.createZbaseCardano(options).settlePrivately({ payouts }), /relayer fee.*limit/i);
  });
  await t.test('SDK-03: a caller can lower the relayer fee limit', async () => {
    quotedFee = 1_000_000n;
    await assert.rejects(sdkModule.createZbaseCardano({ ...options, maxRelayerFee: 999_999n })
      .settlePrivately({ payouts }), /relayer fee.*limit/i);
  });
  for (const delta of [-1n, 1n]) {
    await t.test(`SDK-03: a protocol fee off by ${delta} lovelace is rejected`, async () => {
      quotedFee = 1_000_000n;
      protocolDelta = delta;
      await assert.rejects(sdkModule.createZbaseCardano(options).settlePrivately({ payouts }), /protocol fee/i);
      protocolDelta = 0n;
    });
  }
  await t.test('SDK-03: exact fee limits and integer protocol fee rounding reach the prover', async () => {
    protocolDelta = 0n;
    quotedFee = 2_000_000n;
    await assert.rejects(sdkModule.createZbaseCardano(options).settlePrivately({ payouts }), error => error === proving);
    quotedFee = 3_000_000n;
    await assert.rejects(sdkModule.createZbaseCardano({ ...options, maxRelayerFee: 3_000_000n })
      .settlePrivately({ payouts }), error => error === proving);
  });
  await t.test('SDK-04: an excessive seller price does not reserve a key or request a quote', async () => {
    const sdk = sdkModule.createZbaseCardano(options);
    await sdk.sync();
    const signer = sdk.x402Signer({ maxPrice: 2_000_000n });
    const address = signer.getAddress();
    const before = await store.load();
    const beforeQuotes = quotes;
    await assert.rejects(async () => signer.buildAndSignPaymentTransaction({ network: `cardano:${ctx.deployment.network}`,
      asset: 'lovelace', payTo: seller, amount: '2000001', maxTimeoutSeconds: 300 }), /price.*limit/i);
    assert.equal(quotes, beforeQuotes);
    assert.deepEqual(await store.load(), before);
    assert.equal(signer.getAddress(), address);
  });
  assert.equal(submissions, 0);
  assert.equal((await store.load())!.nextChangeIndex, 0);
  assert.equal((await store.load())!.nextOneTimeIndex, 0);
});

test('SDK-01: hardening stores preserve pending marks and expected refund keys', async t => {
  const build = fileURLToPath(new URL('../build/', import.meta.url));
  await mkdir(build, { recursive: true });
  const path = join(build, `sdk-test-${randomUUID()}.json`);
  t.after(async () => { await unlink(path).catch(() => undefined); });
  const saved: sdkModule.StoreData = { nextDepositIndex: 3, nextChangeIndex: 1, nextOneTimeIndex: 2,
    notes: (['settle', 'exit', 'refund'] as const).map((kind, i) => ({
      id: `d${i}`, kind: 'deposit', secretIndex: i, status: kind === 'settle' ? 'spent' : kind === 'exit' ? 'exited' : 'refunded',
      value: 10_000_000n, label: 42n, leafIndex: i, origin: null, gross: 10_000_000n, precommitment: 123n,
      expectedRefundKeyHash: i === 2 ? null : '11'.repeat(28),
      pending: { kind, validUntil: 1_655_770_020_000, changeNoteId: kind === 'settle' ? 'c0' : null },
    })) };
  for (const [name, store] of [['memory', sdkModule.memoryStore()], ['file', sdkModule.fileStore(path)]] as const) {
    await t.test(`SDK-01: ${name} store round trip`, async () => {
      await store.save(saved);
      const loaded = await store.load();
      assert.deepEqual(loaded, saved);
      loaded!.notes[0]!.pending!.validUntil = 0;
      assert.deepEqual(await store.load(), saved);
    });
  }
});

test('SDK-01, SDK-08: hardening sync uses confirmed data and stable deposit selection', async t => {
  const { ctx, chain } = await startDevnet();
  const indexer = new Indexer({ ctx, history: chain });
  await indexer.sync();
  const pool = await indexer.getPool();
  const seed = new Uint8Array(32).fill(117);
  const secrets = deriveNoteSecrets(seed, 0);
  const pre = precommitment(secrets.nullifier, secrets.secret);
  const refundKeyHash = '11'.repeat(28);
  const base: DepositView = { txId: '22'.repeat(32), index: 1, precommitment: pre, refundKeyHash,
    status: 'absorbed', gross: 10_000_000n, value: 9_700_000n, label: 42n, leafIndex: 0 };
  let deposits: DepositView[] = [base];
  let leaves = [commitment({ ...secrets, value: base.value!, label: base.label! })];
  let queue: bigint[] = [];
  let spent: bigint[] = [];
  const approved = MerkleTree.fromLeaves([42n]);
  const snapshot: IndexerApi = {
    getPool: async () => ({ ...pool, size: leaves.length, roots: [MerkleTree.fromLeaves(leaves).root], queue,
      aspRoot: approved.root }),
    getLeaves: async from => ({ from, size: leaves.length, root: MerkleTree.fromLeaves(leaves).root, leaves: leaves.slice(from) }),
    getAspLeaves: async from => ({ from, root: approved.root, leaves: from === 0 ? [42n] : [] }),
    getDeposits: async () => structuredClone(deposits),
    getNullifiers: async from => ({ from, nullifiers: spent.slice(from) }),
  };
  const unused = async (): Promise<never> => { throw new Error('This sync test must not send a transaction or prove'); };
  const relayer: RelayerApi = { getPool: snapshot.getPool, quote: unused, settle: unused, getSettle: unused };
  const artifacts = { get spend(): never { throw new Error('Unexpected proving'); }, get ragequit(): never { throw new Error('Unexpected proving'); } };
  const initial: sdkModule.NoteRecord = { id: 'd0', kind: 'deposit', secretIndex: 0, status: 'spent',
    value: base.value, label: base.label, leafIndex: 0, gross: base.gross, precommitment: pre,
    origin: { txId: base.txId, index: base.index, refundKeyHash }, expectedRefundKeyHash: refundKeyHash };
  async function restored(notes: sdkModule.NoteRecord[]) {
    const store = sdkModule.memoryStore();
    await store.save({ nextDepositIndex: 1, nextChangeIndex: 1, nextOneTimeIndex: 0, notes });
    const sdk = sdkModule.createZbaseCardano({ seed, ctx, indexer: snapshot, relayer, artifacts, store });
    await sdk.sync();
    return sdk;
  }
  for (const status of ['spent', 'exited', 'refunded'] as const) {
    await t.test(`SDK-01: an unconfirmed legacy ${status} mark is not sticky`, async () => {
      assert.equal((await restored([{ ...initial, status }])).listNotes()[0]!.status, 'spendable');
    });
  }
  await t.test('SDK-01: a confirmed nullifier keeps an exit distinct from a spend', async () => {
    spent = [nullifierHash(secrets.nullifier)];
    assert.equal((await restored([initial])).listNotes()[0]!.status, 'spent');
    assert.equal((await restored([{ ...initial, status: 'exited' }])).listNotes()[0]!.status, 'exited');
    spent = [];
  });
  const largerPending: DepositView = { ...base, txId: '33'.repeat(32), status: 'pending', gross: 40_000_000n,
    value: null, label: null, leafIndex: null };
  const cases: { name: string; choices: DepositView[]; expected: DepositView }[] = [
    { name: 'absorbed before a larger pending deposit', choices: [largerPending, base], expected: base },
    { name: 'pending before a larger refunded deposit', choices: [{ ...largerPending, txId: '44'.repeat(32),
      gross: 50_000_000n, status: 'refunded' }, largerPending], expected: largerPending },
    { name: 'larger credited value among absorbed deposits', choices: [base, { ...base, txId: '33'.repeat(32),
      value: 10_700_000n }], expected: { ...base, txId: '33'.repeat(32), value: 10_700_000n } },
    { name: 'smaller transaction ID breaks value ties', choices: [base, { ...base, txId: '11'.repeat(32) }],
      expected: { ...base, txId: '11'.repeat(32) } },
    { name: 'smaller output index breaks transaction ties', choices: [base, { ...base, index: 0 }], expected: { ...base, index: 0 } },
  ];
  for (const example of cases) {
    await t.test(`SDK-08: ${example.name}`, async () => {
      for (const reverse of [false, true]) {
        deposits = structuredClone(example.choices);
        if (reverse) deposits.reverse();
        leaves = [];
        for (const d of deposits) if (d.status === 'absorbed') {
          d.leafIndex = leaves.length;
          leaves.push(commitment({ ...secrets, value: d.value!, label: d.label! }));
        }
        const actual = (await restored([initial])).listNotes()[0]!;
        assert.deepEqual(actual.origin, { txId: example.expected.txId, index: example.expected.index, refundKeyHash });
        assert.equal(actual.status, example.expected.status === 'absorbed' ? 'spendable' : 'deposited');
        assert.equal(actual.value, example.expected.value);
      }
    });
  }
  await t.test('SDK-08: preparation ignores a copied pending deposit with another refund key', async () => {
    deposits = [{ ...largerPending, refundKeyHash: 'aa'.repeat(28) }];
    leaves = [];
    const sdk = sdkModule.createZbaseCardano({ seed, ctx, indexer: snapshot, relayer, artifacts });
    await sdk.prepareDeposit({ amount: 10_000_000n, refundKeyHash });
    await sdk.sync();
    assert.equal(sdk.listNotes()[0]!.status, 'created');
    assert.equal(sdk.listNotes()[0]!.origin, null);
  });
  for (const location of ['absent', 'queue', 'leaves'] as const) {
    await t.test(`SDK-01: expired settlement change in ${location} is reconciled from chain data`, async () => {
      const changeSecrets = deriveNoteSecrets(seed, 2 ** 20);
      const change: sdkModule.NoteRecord = { ...initial, id: 'c0', kind: 'change', secretIndex: 2 ** 20,
        status: 'queued', value: 6_700_000n, leafIndex: null, gross: null,
        precommitment: precommitment(changeSecrets.nullifier, changeSecrets.secret) };
      const leaf = commitment({ ...changeSecrets, value: change.value!, label: change.label! });
      deposits = [base];
      leaves = [commitment({ ...secrets, value: base.value!, label: base.label! })];
      queue = location === 'queue' ? [leaf] : [];
      if (location === 'leaves') leaves.push(leaf);
      const sdk = await restored([{ ...initial, pending: { kind: 'settle', changeNoteId: change.id,
        validUntil: slotToTime(pool.tip.slot, ctx.deployment.network) - 120_001 } }, change]);
      assert.equal(sdk.listNotes()[0]!.status, 'spendable');
      assert.equal(sdk.listNotes()[0]!.pending, undefined);
      const retained = sdk.listNotes().find(n => n.id === change.id);
      if (location === 'absent') assert.equal(retained, undefined);
      else assert.equal(retained!.status, location === 'queue' ? 'queued' : 'spendable');
    });
  }
  await t.test('SDK-03: a pending mark prevents both explicit and automatic selection', async () => {
    queue = [];
    const sdk = await restored([{ ...initial, status: 'spendable', pending: { kind: 'settle', changeNoteId: null,
      validUntil: slotToTime(pool.tip.slot, ctx.deployment.network) + 300_000 } }]);
    assert.equal(sdk.balance().spendable, 0n);
    const payouts = [{ address: enterpriseAddress(new Uint8Array(32).fill(118), ctx.deployment.network), amount: 2_000_000n }];
    await assert.rejects(sdk.settlePrivately({ payouts }), /no spendable note/i);
    await assert.rejects(sdk.settlePrivately({ payouts, noteId: 'd0' }), /not spendable/i);
  });
});

test('SDK-01, SDK-03, SDK-04: Round 2 preserves uncertain submissions and recovers one-time funds', {
  timeout: 1_800_000,
  skip: devKeysPresent(root) ? false : 'Development proving keys are absent: circuits/build/dev/manifest.json is required',
}, async t => {
  const { chain, ctx, keys } = await startDevnet();
  const network = ctx.deployment.network;
  chain.advanceSlots(NETWORKS[network].zeroSlot);
  const walletSeed = keys.users[0]!;
  const seller = enterpriseAddress(keys.users[1]!, network);
  let asp: AspService;
  const indexer = new Indexer({ ctx, history: chain, aspLeaves: () => asp.leaves() });
  asp = new AspService({ ctx, indexer, payerSeed: keys.operator, operatorSeeds: [keys.asp] });
  await indexer.sync();
  const artifacts = { spend: await loadDevArtifacts('spend', root), ragequit: await loadDevArtifacts('ragequit', root) };
  const crank = new Crank({ ctx, indexer, seed: keys.crank, artifacts: await loadDevArtifacts('insert', root) });
  let now = (await chain.getTip()).time;
  const makeRelayer = () => new Relayer({ ctx, indexer, seed: keys.relayer, vkey: artifacts.spend.vkey,
    now: () => now, retryDelayMs: 1 });
  async function advance() {
    chain.mineBlock();
    await indexer.sync();
    await crank.tick();
    chain.mineBlock();
    await indexer.sync();
    await asp.tick();
    chain.mineBlock();
    await indexer.sync();
    now = (await chain.getTip()).time;
  }
  async function reach(time: number) {
    chain.mineBlock(timeToSlot(time, network) - (await chain.getTip()).slot);
    now = (await chain.getTip()).time;
    await indexer.sync();
  }
  const options = { ctx, indexer, artifacts, poll: { intervalMs: 1, timeoutMs: 600_000, onPoll: advance } };
  const payouts = [{ address: seller, amount: 2_000_000n }];

  for (const accepted of [true, false]) {
    await t.test(`SDK-03: an unknown settle outcome ${accepted ? 'confirms with its change' : 'expires and restores its note'}`, async () => {
      const seed = new Uint8Array(32).fill(accepted ? 131 : 132);
      const store = sdkModule.memoryStore();
      const relayer = makeRelayer();
      let calls = 0;
      let atSubmit: sdkModule.StoreData | null = null;
      const failure = new Error('Lost settlement answer');
      const wrapper: RelayerApi = {
        getPool: () => relayer.getPool(), quote: payouts => relayer.quote(payouts), getSettle: id => relayer.getSettle(id),
        settle: async request => {
          calls++;
          atSubmit = await store.load();
          if (accepted) await relayer.settle(request);
          throw failure;
        },
      };
      const sdk = sdkModule.createZbaseCardano({ ...options, seed, store, relayer: wrapper });
      const deposited = await sdk.deposit({ amount: 12_000_000n, walletSeed });
      await sdk.waitForNote(deposited.prepared.noteId);
      await assert.rejects(sdk.settlePrivately({ payouts }), error => error instanceof Error
        && /outcome is unknown.*note d0/i.test(error.message) && error.cause === failure);
      assert.equal(calls, 1);
      const saved = (await store.load())!;
      assert.deepEqual(atSubmit, saved);
      const original = saved.notes.find(n => n.id === 'd0')!;
      assert.equal(original.status, 'spent');
      assert.equal(original.pending?.kind, 'settle');
      assert.equal(original.pending.changeNoteId, 'c0');
      assert.equal(saved.notes.find(n => n.id === 'c0')!.value, 8_700_000n);
      const resumed = sdkModule.createZbaseCardano({ ...options, seed, store, relayer: makeRelayer() });
      if (accepted) {
        chain.mineBlock();
        await indexer.sync();
        await resumed.sync();
        assert.equal(resumed.listNotes().find(n => n.id === 'd0')!.status, 'spent');
        assert.equal(resumed.listNotes().find(n => n.id === 'd0')!.pending, undefined);
        assert.equal(resumed.listNotes().find(n => n.id === 'c0')!.status, 'queued');
        assert.equal((await resumed.waitForNote('c0')).status, 'spendable');
        assert.equal(resumed.balance().spendable, 8_700_000n);
        const receipt = await resumed.settlePrivately({ payouts, noteId: 'c0' });
        await advance();
        assert.ok((await chain.getUtxosAt(seller)).some(u => u.ref.txId === receipt.txHash));
      } else {
        await resumed.sync();
        assert.deepEqual(resumed.listNotes().find(n => n.id === 'd0'), original);
        await reach(original.pending.validUntil + 120_000);
        await resumed.sync();
        assert.ok(resumed.listNotes().find(n => n.id === 'd0')!.pending);
        await reach(original.pending.validUntil + 121_000);
        await resumed.sync();
        assert.equal(resumed.listNotes().length, 1);
        assert.equal(resumed.listNotes()[0]!.pending, undefined);
        assert.equal(resumed.listNotes()[0]!.status, 'spendable');
        assert.equal(resumed.balance().spendable, 11_700_000n);
      }
    });
  }

  for (const retry of [false, true]) {
    await t.test(`SDK-03: definite API refusals clean tentative records ${retry ? 'on every retry' : 'before throwing'}`, async () => {
      const seed = new Uint8Array(32).fill(retry ? 133 : 134);
      const store = sdkModule.memoryStore();
      const relayer = makeRelayer();
      const snapshots: sdkModule.StoreData[] = [];
      const codes: ErrorCode[] = retry ? ['stale_root', 'stale_asp_root', 'internal'] : ['queue_full'];
      const wrapper: RelayerApi = {
        getPool: () => relayer.getPool(), quote: payouts => relayer.quote(payouts), getSettle: id => relayer.getSettle(id),
        settle: async () => {
          snapshots.push((await store.load())!);
          throw new ApiError(codes[snapshots.length - 1]!, 'Definite refusal');
        },
      };
      const sdk = sdkModule.createZbaseCardano({ ...options, seed, store, relayer: wrapper });
      const deposited = await sdk.deposit({ amount: 12_000_000n, walletSeed });
      await sdk.waitForNote(deposited.prepared.noteId);
      await assert.rejects(sdk.settlePrivately({ payouts }), error => error instanceof ApiError && error.code === codes.at(-1));
      assert.equal(snapshots.length, codes.length);
      snapshots.forEach((snapshot, i) => {
        assert.equal(snapshot.notes.length, 2);
        assert.equal(snapshot.notes[0]!.pending?.changeNoteId, `c${i}`);
        assert.equal(snapshot.notes[1]!.id, `c${i}`);
      });
      const saved = (await store.load())!;
      assert.equal(saved.notes.length, 1);
      assert.equal(saved.notes[0]!.pending, undefined);
      assert.equal(saved.notes[0]!.status, 'spendable');
      assert.equal(saved.nextChangeIndex, codes.length);
    });
  }

  for (const kind of ['exit', 'refund'] as const) {
    for (const accepted of [true, false]) {
      await t.test(`SDK-01: an unknown ${kind} outcome ${accepted ? 'confirms after restart' : 'expires safely'}`, async () => {
        const seed = new Uint8Array(32).fill((kind === 'exit' ? 135 : 137) + (accepted ? 0 : 1));
        const store = sdkModule.memoryStore();
        const relayer = makeRelayer();
        const sdk = sdkModule.createZbaseCardano({ ...options, seed, store, relayer });
        const deposited = await sdk.deposit({ amount: 12_000_000n, walletSeed });
        if (kind === 'exit') await sdk.waitForNote(deposited.prepared.noteId);
        else { chain.mineBlock(); await indexer.sync(); }
        let atSubmit: sdkModule.StoreData | null = null;
        let calls = 0;
        const failure = new Error('Lost submission answer');
        const provider: Provider = { ...droppingProvider(chain, []), submit: async cbor => {
          calls++;
          atSubmit = await store.load();
          if (accepted) await chain.submit(cbor);
          throw failure;
        } };
        const losing = sdkModule.createZbaseCardano({ ...options, ctx: { ...ctx, provider }, seed, store, relayer });
        const args = { noteId: deposited.prepared.noteId, refundSeed: walletSeed };
        await assert.rejects(kind === 'exit' ? losing.ragequit(args) : losing.refund(args), error => error instanceof Error
          && /outcome is unknown.*note d0/i.test(error.message) && error.cause === failure);
        assert.equal(calls, 1);
        assert.deepEqual(atSubmit, await store.load());
        const mark = losing.listNotes()[0]!;
        assert.equal(mark.pending?.kind, kind);
        const resumed = sdkModule.createZbaseCardano({ ...options, seed, store, relayer });
        if (accepted) { chain.mineBlock(); await indexer.sync(); }
        else {
          await resumed.sync();
          assert.deepEqual(resumed.listNotes()[0], mark);
          await reach(mark.pending!.validUntil + 121_000);
        }
        await resumed.sync();
        assert.equal(resumed.listNotes()[0]!.pending, undefined);
        assert.equal(resumed.listNotes()[0]!.status, accepted ? kind === 'exit' ? 'exited' : 'refunded'
          : kind === 'exit' ? 'spendable' : 'deposited');
      });
    }
  }

  await t.test('SDK-04: recover a funded one-time output when the seller leg was never submitted', async () => {
    const seed = new Uint8Array(32).fill(139);
    const store = sdkModule.memoryStore();
    const sdk = sdkModule.createZbaseCardano({ ...options, seed, store, relayer: makeRelayer() });
    const deposited = await sdk.deposit({ amount: 12_000_000n, walletSeed });
    await sdk.waitForNote(deposited.prepared.noteId);
    const signer = sdk.x402Signer();
    const address = signer.getAddress();
    await signer.buildAndSignPaymentTransaction({ network: `cardano:${network}`, asset: 'lovelace',
      payTo: seller, amount: '2000000', maxTimeoutSeconds: 300 });
    const [funding] = await chain.getUtxosAt(address);
    assert.ok(funding);
    assert.equal(typeof sdk.recoverOneTimeFunds, 'function');
    const before = (await store.load())!.nextOneTimeIndex;
    const payTo = enterpriseAddress(new Uint8Array(32).fill(140), network);
    const result = await sdk.recoverOneTimeFunds({ index: 0, payTo });
    assert.ok(result);
    chain.mineBlock();
    const view = decodeTx(await chain.getTransactionCbor(result.txId));
    assert.deepEqual(view.inputs, [funding.ref]);
    assert.equal(view.outputs.length, 1);
    assert.equal(view.outputs[0]!.address, payTo);
    assert.equal(result.amount, funding.value.lovelace - view.fee);
    assert.equal(view.outputs[0]!.value.lovelace, result.amount);
    assert.deepEqual((await chain.getUtxosAt(payTo)).map(u => u.value.lovelace), [result.amount]);
    assert.equal((await chain.getUtxosAt(address)).length, 0);
    assert.equal(await sdk.recoverOneTimeFunds({ index: 0, payTo }), null);
    assert.equal((await store.load())!.nextOneTimeIndex, before);
  });
});

test('SDK-04: Round 2 recovery checks destinations and selects the largest confirmed output', async t => {
  const { chain, ctx, keys } = await startDevnet();
  const network = ctx.deployment.network;
  const seed = new Uint8Array(32).fill(141);
  const store = sdkModule.memoryStore();
  await store.save({ notes: [], nextDepositIndex: 0, nextChangeIndex: 0, nextOneTimeIndex: 9 });
  const indexer = new Indexer({ ctx, history: chain });
  const relayer = new Relayer({ ctx, indexer, seed: keys.relayer, vkey: await loadDevVkey('spend', root) });
  const artifacts = { get spend(): never { throw new Error('Unexpected proving'); }, get ragequit(): never { throw new Error('Unexpected proving'); } };
  let reads = 0;
  let submitted = 0;
  const evaluated: string[] = [];
  let rejectEvaluation = false;
  const evaluationError = new Error('Recovery evaluation failed');
  const provider: Provider = { ...droppingProvider(chain, []),
    getUtxosAt: address => { reads++; return chain.getUtxosAt(address); },
    evaluate: async (cbor, additional) => {
      if (rejectEvaluation) throw evaluationError;
      const result = await chain.evaluate(cbor, additional);
      evaluated.push(cbor);
      return result;
    },
    submit: cbor => {
      assert.ok(evaluated.includes(cbor), 'Recovery must evaluate before submitting');
      submitted++;
      return chain.submit(cbor);
    },
  };
  const sdk = sdkModule.createZbaseCardano({ seed, store, ctx: { ...ctx, provider }, indexer, relayer, artifacts });
  const payTo = enterpriseAddress(keys.users[0]!, network);
  await t.test('SDK-04: a destination on another network fails before reading or submitting', async () => {
    const wrong = enterpriseAddress(keys.users[0]!, 'mainnet');
    await assert.rejects(async () => sdk.recoverOneTimeFunds({ index: 0, payTo: wrong }), /network/i);
    assert.equal(reads, 0);
    assert.equal(submitted, 0);
  });
  await t.test('SDK-04: invalid recovery indexes fail before reading or submitting', async () => {
    for (const index of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      await assert.rejects(async () => sdk.recoverOneTimeFunds({ index, payTo }), /index/i);
    }
    assert.equal(reads, 0);
    assert.equal(submitted, 0);
  });
  await t.test('SDK-04: an empty one-time address returns null without changing its counter', async () => {
    assert.equal(await sdk.recoverOneTimeFunds({ index: 0, payTo }), null);
    assert.equal(submitted, 0);
    assert.equal((await store.load())!.nextOneTimeIndex, 9);
  });
  const key = deriveOneTimeKey(seed, 3);
  const address = enterpriseAddress(key, network);
  key.fill(0);
  const add = (lovelace: bigint) => chain.addUtxo({ address, value: { lovelace, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null });
  const small = add(2_000_000n);
  const large = add(5_000_000n);
  await t.test('SDK-04: a failed evaluation never submits a recovery transaction', async () => {
    rejectEvaluation = true;
    try { await assert.rejects(async () => sdk.recoverOneTimeFunds({ index: 3, payTo }), error => error === evaluationError); }
    finally { rejectEvaluation = false; }
    assert.equal(submitted, 0);
    assert.equal((await chain.getUtxosAt(address)).length, 2);
  });
  await t.test('SDK-04: recovery spends only the largest output and leaves the counter unchanged', async () => {
    const fee = await stealthFee({ provider: chain, network }, { payTo, price: 5_000_000n });
    const recovered = await sdk.recoverOneTimeFunds({ index: 3, payTo });
    assert.ok(recovered);
    chain.mineBlock();
    const view = decodeTx(await chain.getTransactionCbor(recovered.txId));
    assert.deepEqual(view.inputs, [large]);
    assert.equal(view.outputs.length, 1);
    assert.equal(recovered.amount, 5_000_000n - fee);
    assert.equal(view.outputs[0]!.value.lovelace, recovered.amount);
    assert.deepEqual((await chain.getUtxosAt(address)).map(u => u.ref), [small]);
    assert.equal((await store.load())!.nextOneTimeIndex, 9);
    await sdk.recoverOneTimeFunds({ index: 3, payTo });
    chain.mineBlock();
    assert.equal(await sdk.recoverOneTimeFunds({ index: 3, payTo }), null);
    assert.equal((await store.load())!.nextOneTimeIndex, 9);
  });
});
