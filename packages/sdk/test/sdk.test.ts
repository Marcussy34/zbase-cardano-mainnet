import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, type ErrorCode, type IndexerApi, type RelayerApi, type SettleRequest } from '@zbase-cardano/api';
import { commitment, deriveNoteSecrets, MerkleTree, NETWORKS, nullifierHash, precommitment, type Note } from '@zbase-cardano/crypto';
import { devKeysPresent, loadDevArtifacts, shutdown } from '@zbase-cardano/prover';
import { decodeDepositDatum, decodeTx, enterpriseAddress, keyHash } from '@zbase-cardano/txlib';
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
    assert.deepEqual(recovered.listNotes(), sdk.listNotes());
    const next = await recovered.prepareDeposit({ amount: 10_000_000n, refundKeyHash });
    assert.equal(next.noteId, 'd1');
  });
  await step('SDK-03: private settlement pays exactly and inserts the queued change', async () => {
    const oldValue = note(noteId).value!;
    const receipt = await sdk.settlePrivately({ payouts: [{ address: seller, amount: 3_000_000n }] });
    assert.equal(note(noteId).status, 'spent');
    assert.ok(receipt.changeNoteId);
    changeId = receipt.changeNoteId;
    assert.equal(note(changeId).status, 'queued');
    assert.equal((await sdk.waitForSettle(receipt.id)).status, 'confirmed');
    await sdk.waitForNote(changeId);
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
    chain.mineBlock();
    await indexer.sync();
    await sdk.sync();
    const tx = decodeTx(await chain.getTransactionCbor(result.txId));
    assert.equal(await balance() - before, 9_700_000n - tx.fee);
    assert.equal(note(id).status, 'exited');
  });
  await step('SDK-06: a pending deposit can be refunded before a crank round', async () => {
    const deposited = await sdk.deposit({ amount: 10_000_000n, walletSeed });
    chain.mineBlock();
    await indexer.sync();
    await sdk.sync();
    assert.equal(note(deposited.prepared.noteId).status, 'deposited');
    await sdk.refund({ noteId: deposited.prepared.noteId, refundSeed: walletSeed });
    chain.mineBlock();
    await indexer.sync();
    await sdk.sync();
    assert.equal(note(deposited.prepared.noteId).status, 'refunded');
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
