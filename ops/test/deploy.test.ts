import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ZERO_HASHES, type SnarkjsVk } from '@zbase-cardano/crypto';
import {
  buildDeposit, buildRefund, decodeTx, enterpriseAddress, readAsp, readConfig, readDeposits, readPool, signTx,
  type Network, type Provider, type Utxo,
} from '@zbase-cardano/txlib';
import { FakeChain } from '@zbase-cardano/txlib/testing/fake-chain';
import { deploy, deployCost, pollConfirm, runDeployCommand, type DeployOptions } from '../src/deploy.js';
import { readSettings } from '../src/env.js';
import { roleAddress, roleKeyHash, roleSeed, type Role } from '../src/roles.js';
import { runSetup, setupPaths } from '../src/setup.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const operatorSeed = new Uint8Array(32).fill(19);
const network = 'preprod';
const operatorAddress = enterpriseAddress(operatorSeed, network);
const roles: Role[] = ['operator', 'holder', 'admin', 'asp', 'crank', 'relayer', 'user', 'agent', 'seller'];
const lovelace = (utxos: Utxo[]): bigint => utxos.reduce((sum, u) => sum + u.value.lovelace, 0n);

async function options(balance = 400_000_000n, network: Network = 'preprod') {
  const chain = new FakeChain({ network });
  const operatorAddress = enterpriseAddress(operatorSeed, network);
  chain.addUtxo({ address: operatorAddress, value: { lovelace: balance, assets: {} }, inlineDatum: null, datumHash: null, scriptRef: null });
  const keys = await Promise.all(['spend', 'insert', 'ragequit'].map(async circuit =>
    JSON.parse(await readFile(join(repoRoot, 'artifacts/dev', `${circuit}_vkey.json`), 'utf8')) as SnarkjsVk));
  const transactions: string[] = [];
  const logs: string[] = [];
  let awaitingConfirmation = false;
  const provider: Provider = {
    getUtxos: refs => chain.getUtxos(refs),
    getUtxosAt: address => chain.getUtxosAt(address),
    getProtocolParameters: () => chain.getProtocolParameters(),
    getTip: () => chain.getTip(),
    evaluate: (cbor, additional) => chain.evaluate(cbor, additional),
    submit: async cbor => {
      assert.equal(awaitingConfirmation, false, 'Confirm each transaction before submitting the next');
      const view = decodeTx(cbor);
      for (const u of await chain.getUtxos([...view.inputs, ...view.collateral])) assert.equal(u.scriptRef, null);
      const id = await chain.submit(cbor);
      transactions.push(cbor);
      awaitingConfirmation = true;
      return id;
    },
  };
  const o: DeployOptions = { provider, network, operatorSeed,
    vkeys: { spend: keys[0]!, insert: keys[1]!, ragequit: keys[2]! },
    confirm: async id => {
      assert.equal(awaitingConfirmation, true);
      const block = chain.mineBlock();
      assert.deepEqual(block.txIds, [id]);
      assert.equal((await chain.getUtxos([{ txId: id, index: 0 }])).length, 1);
      awaitingConfirmation = false;
    },
    log: line => logs.push(line),
  };
  return { o, chain, transactions, logs };
}

test('OPS-01, OPS-02, OPS-04: deploy, recover the record, deposit, and refund on the in-memory chain', { timeout: 180_000 }, async t => {
  const { o, chain, transactions, logs } = await options();
  const cost = await deployCost(o);
  assert.equal(transactions.length, 0, 'Costing must never submit');
  assert.equal(cost.funding, 160_000_000n);
  assert.equal(cost.total, cost.funding + cost.referenceScripts + cost.pool + cost.fees);
  const record = await deploy(o);
  const ctx = { provider: chain, deployment: record };
  assert.equal(record.network, network);
  assert.equal(record.poolId, record.scripts.nft.hash);
  assert.equal(transactions.length, 4);
  assert.equal(record.initTx, decodeTx(transactions.at(-1)!).txId);
  assert.deepEqual(record.seed, { txId: decodeTx(transactions[0]!).txId, index: 0 });
  assert.equal(decodeTx(transactions[0]!).outputs[0]!.value.lovelace, 5_000_000n);
  assert.equal(decodeTx(transactions[0]!).outputs[0]!.address, operatorAddress);
  assert.equal((await chain.getUtxos([record.seed])).length, 0, 'Init consumes its one-shot seed');
  const pool = await readPool(ctx);
  assert.deepEqual(pool.datum, { roots: [ZERO_HASHES[32]!], size: 0, queue: [], nullifierRoot: '00'.repeat(32), feesAccrued: 0n });
  assert.equal(pool.balance, 6_000_000n);
  assert.deepEqual((await readConfig(ctx)).datum, {
    admins: [roleKeyHash(operatorSeed, 'admin')], adminThreshold: 1,
    treasury: { payment: { kind: 'key', hash: new Uint8Array(Buffer.from(roleKeyHash(operatorSeed, 'operator'), 'hex')) }, stake: null },
    depositsPaused: false, minDeposit: 5_000_000n, maxDeposit: 50_000_000n, poolCap: 500_000_000n,
    depositFeeBps: 0, settleFeeBps: 0, crankFee: 300_000n,
  });
  assert.deepEqual((await readAsp(ctx)).datum, { root: ZERO_HASHES[32]!, operators: [roleKeyHash(operatorSeed, 'asp')], threshold: 1, uri: '' });
  const held = await chain.getUtxosAt(roleAddress(operatorSeed, 'holder', network));
  assert.equal(held.length, 4);
  for (const name of ['pool', 'deposit', 'config', 'asp'] as const) {
    const [utxo] = await chain.getUtxos([record.refScripts[name]]);
    assert.equal(utxo?.address, roleAddress(operatorSeed, 'holder', network));
    assert.equal(utxo?.scriptRef?.hash, record.scripts[name].hash);
  }
  assert.equal(lovelace(held), cost.referenceScripts);
  for (const [role, amount] of [['asp', 20_000_000n], ['crank', 30_000_000n], ['relayer', 30_000_000n], ['user', 60_000_000n]] as const) {
    const amounts = (await chain.getUtxosAt(roleAddress(operatorSeed, role, network))).map(u => u.value.lovelace);
    assert.deepEqual(amounts.sort(), [5_000_000n, amount].sort());
  }
  for (const role of ['admin', 'agent', 'seller'] as const) assert.equal((await chain.getUtxosAt(roleAddress(operatorSeed, role, network))).length, 0);
  const restored = JSON.parse(JSON.stringify(record));
  assert.deepEqual(restored, record);
  assert.deepEqual(await readPool({ provider: chain, deployment: restored }), pool);
  const spent = 400_000_000n - lovelace(await chain.getUtxosAt(operatorAddress));
  assert.ok(cost.total >= spent, 'Cost should conservatively cover actual spending');
  assert.ok(cost.total - spent < 2_000_000n, 'Cost must be accurate within 2 ADA');
  assert.equal(logs.filter(line => transactions.some(cbor => line.includes(decodeTx(cbor).txId))).length, 4);
  assert.ok(logs.every(line => !line.includes(Buffer.from(operatorSeed).toString('hex'))));
  t.diagnostic(JSON.stringify({ cost, spent, sizes: transactions.map(cbor => decodeTx(cbor).size), fees: transactions.map(cbor => decodeTx(cbor).fee) }, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value));

  const user = roleSeed(operatorSeed, 'user');
  const address = roleAddress(operatorSeed, 'user', network);
  const deposit = await buildDeposit({ ...ctx, deployment: restored }, { payer: { address }, amount: 10_000_000n, precommitment: 42n, refundKeyHash: roleKeyHash(operatorSeed, 'user') });
  await chain.submit(signTx(deposit.cbor, [user]));
  chain.mineBlock();
  const deposits = await readDeposits(ctx);
  assert.equal(deposits.length, 1);
  const refund = await buildRefund(ctx, { payer: { address }, deposit: deposits[0]!, payTo: address });
  await chain.submit(signTx(refund.cbor, [user]));
  chain.mineBlock();
  assert.deepEqual(await readDeposits(ctx), []);
  assert.equal(lovelace(await chain.getUtxosAt(address)), 65_000_000n - deposit.fee - refund.fee);
});

test('OPS-02: insufficient spendable ADA fails before submitting', { timeout: 180_000 }, async () => {
  const { o, chain, transactions } = await options(1_000_000n);
  const cost = await deployCost(o);
  await assert.rejects(deploy(o), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(operatorAddress));
    assert.match(error.message, /ADA/);
    assert.ok(error.message.includes((Number(cost.total) / 1_000_000).toFixed(6)));
    assert.ok(error.message.includes('1.000000'));
    return true;
  });
  assert.equal(transactions.length, 0);
  assert.equal(lovelace(await chain.getUtxosAt(operatorAddress)), 1_000_000n);
});

test('OPS-03: role derivation separates keys and preserves the operator seed', () => {
  const derived = roles.map(role => roleSeed(operatorSeed, role));
  assert.deepEqual(derived[0], operatorSeed);
  assert.equal(new Set(derived.map(seed => Buffer.from(seed).toString('hex'))).size, roles.length);
  roles.forEach((role, index) => {
    assert.deepEqual(roleSeed(operatorSeed, role), derived[index]);
    assert.equal(derived[index]!.length, 32);
    if (role !== 'operator') assert.deepEqual(derived[index], new Uint8Array(hkdfSync('sha256', operatorSeed, new Uint8Array(), `zbase/role/${role}/v1`, 32)));
    assert.equal(roleKeyHash(operatorSeed, role).length, 56);
    assert.equal(roleAddress(operatorSeed, role, network), enterpriseAddress(derived[index]!, network));
    assert.match(roleAddress(operatorSeed, role, 'mainnet'), /^addr1/);
  });
  assert.throws(() => roleSeed(new Uint8Array(31), 'admin'), /32/);
});

test('OPS-03: settings validate each variable without leaking supplied values', () => {
  const valid = { NETWORK: 'preprod', BLOCKFROST_PROJECT_ID: `preprod${'a'.repeat(32)}`, OPERATOR_SEED_HEX: Buffer.from(operatorSeed).toString('hex') };
  assert.deepEqual(readSettings(valid), { network, blockfrostProjectId: valid.BLOCKFROST_PROJECT_ID, operatorSeed });
  for (const [name, value] of [['NETWORK', 'unknown-network'], ['BLOCKFROST_PROJECT_ID', 'wrong-project-id'], ['OPERATOR_SEED_HEX', 'invalid-seed']]) {
    for (const invalid of [undefined, '', value]) {
      const env = { ...valid, [name!]: invalid };
      assert.throws(() => readSettings(env), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(name!));
        for (const supplied of Object.values(env)) if (supplied) assert.ok(!error.message.includes(supplied));
        return true;
      });
    }
  }
});

test('OPS-05: setup stages phase 1, publishes public files, and preserves existing work', async () => {
  const build = join(repoRoot, 'ops/build');
  await mkdir(build, { recursive: true });
  const root = await mkdtemp(join(build, 'setup-test-'));
  try {
    const paths = setupPaths(root, network);
    assert.deepEqual(paths, { workDir: join(root, 'circuits/build/keys-preprod'), publishDir: join(root, 'deployments/preprod/keys'), ptauSource: join(root, 'circuits/build/dev/pot16_final.ptau') });
    await mkdir(dirname(paths.ptauSource), { recursive: true });
    await writeFile(paths.ptauSource, 'test-only phase 1 bytes');
    await writeFile(join(dirname(paths.ptauSource), 'phase1-verified.json'), '{"verified":true}');
    const publicFiles = ['spend_vkey.json', 'insert_vkey.json', 'ragequit_vkey.json', 'manifest.json'];
    let calls = 0;
    const run = async (command: string, args: string[]) => {
      calls++;
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [join(root, 'circuits/scripts/setup-dev.mjs'), '--out-dir', paths.workDir]);
      assert.equal(await readFile(join(paths.workDir, 'pot16_final.ptau'), 'utf8'), calls === 1 ? 'test-only phase 1 bytes' : 'existing work');
      assert.equal(await readFile(join(paths.workDir, 'phase1-verified.json'), 'utf8'), '{"verified":true}');
      for (const file of publicFiles) await writeFile(join(paths.workDir, file), JSON.stringify({ file, calls }));
      await writeFile(join(paths.workDir, 'spend.zkey'), 'fake proving key');
    };
    await runSetup({ repoRoot: root, network, run });
    assert.deepEqual((await readdir(paths.publishDir)).sort(), publicFiles.sort());
    for (const file of publicFiles) assert.equal(await readFile(join(paths.publishDir, file), 'utf8'), await readFile(join(paths.workDir, file), 'utf8'));
    await writeFile(join(paths.workDir, 'pot16_final.ptau'), 'existing work');
    await rm(paths.ptauSource);
    await runSetup({ repoRoot: root, network, run });
    assert.equal(calls, 2);
    assert.equal(await readFile(join(paths.publishDir, 'manifest.json'), 'utf8'), JSON.stringify({ file: 'manifest.json', calls: 2 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OPS-01: confirmation waits for output zero and times out on missing outputs', async () => {
  const chain = new FakeChain({ network });
  const id = 'ac'.repeat(32);
  const confirmation = pollConfirm(chain, { intervalMs: 2, timeoutMs: 1000 })(id);
  const timer = setTimeout(() => chain.addUtxo({ ref: { txId: id, index: 0 }, address: operatorAddress,
    value: { lovelace: 5_000_000n, assets: {} }, inlineDatum: null, datumHash: null, scriptRef: null }), 10);
  try { await confirmation; } finally { clearTimeout(timer); }
  await assert.rejects(pollConfirm(chain, { intervalMs: 2, timeoutMs: 10 })('ad'.repeat(32)), /timed out/i);
});

test('OPS-01, OPS-02: the CLI dry run writes nothing and deployment records require explicit replacement', { timeout: 180_000 }, async () => {
  const { o, transactions } = await options();
  const build = join(repoRoot, 'ops/build');
  await mkdir(build, { recursive: true });
  const root = await mkdtemp(join(build, 'cli-test-'));
  const logs: string[] = [];
  const env = { NETWORK: network, BLOCKFROST_PROJECT_ID: `preprod${'b'.repeat(32)}`, OPERATOR_SEED_HEX: Buffer.from(operatorSeed).toString('hex') };
  try {
    for (const folder of ['artifacts/dev', 'deployments/preprod/keys']) {
      await mkdir(join(root, folder), { recursive: true });
      for (const circuit of ['spend', 'insert', 'ragequit']) {
        await copyFile(join(repoRoot, 'artifacts/dev', `${circuit}_vkey.json`), join(root, folder, `${circuit}_vkey.json`));
      }
    }
    const base = { repoRoot: root, env, provider: o.provider, confirm: o.confirm, log: (line: string) => logs.push(line) };
    await runDeployCommand({ ...base, argv: ['--dry-run', '--dev-keys'] });
    assert.equal(transactions.length, 0);
    await assert.rejects(readFile(join(root, 'deployments/preprod.json')), { code: 'ENOENT' });
    for (const role of roles) assert.ok(logs.some(line => line.includes(roleAddress(operatorSeed, role, network))));
    for (const label of ['total:', 'funding:', 'referenceScripts:', 'pool:', 'fees:', 'operator balance:']) assert.ok(logs.some(line => line.startsWith(label)));
    await runDeployCommand({ ...base, argv: [] });
    assert.equal(transactions.length, 4);
    const output = join(root, 'deployments/preprod.json');
    const original = await readFile(output, 'utf8');
    const record = JSON.parse(original);
    assert.equal((await readPool({ provider: o.provider, deployment: record })).balance, 6_000_000n);
    await assert.rejects(runDeployCommand({ ...base, argv: [] }), /already exists/);
    assert.equal(transactions.length, 4);
    assert.equal(await readFile(output, 'utf8'), original);
    const second = await options();
    await runDeployCommand({ ...base, provider: second.o.provider, confirm: second.o.confirm, argv: ['--out', output, '--force', '--dev-keys'] });
    assert.equal(second.transactions.length, 4);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).initTx, decodeTx(second.transactions.at(-1)!).txId);
    for (const line of logs) {
      assert.ok(!line.includes(env.OPERATOR_SEED_HEX));
      assert.ok(!line.includes(env.BLOCKFROST_PROJECT_ID));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OPS-02: exact estimated funds suffice with config and funding overrides', { timeout: 180_000 }, async () => {
  const initial = await options();
  const overrides = { funding: { user: 10_000_000n }, config: { depositsPaused: true, crankFee: 400_000n } };
  const cost = await deployCost({ ...initial.o, ...overrides });
  const { o, chain } = await options(cost.total);
  const record = await deploy({ ...o, ...overrides });
  const config = (await readConfig({ provider: chain, deployment: record })).datum;
  assert.equal(config.depositsPaused, true);
  assert.equal(config.crankFee, 400_000n);
  assert.equal(lovelace(await chain.getUtxosAt(roleAddress(operatorSeed, 'user', network))), 15_000_000n);
  assert.ok(lovelace(await chain.getUtxosAt(operatorAddress)) < 2_000_000n);
});

test('OPS-02: reference outputs cannot fund deployment and invalid config cannot submit', { timeout: 180_000 }, async () => {
  const { o, chain, transactions } = await options(1_000_000n);
  const ref = chain.addUtxo({ address: operatorAddress, value: { lovelace: 400_000_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: { hash: '11'.repeat(28), cbor: '82034100', size: 1 } });
  await assert.rejects(deploy(o), /available spendable balance is 1.000000 ADA/);
  assert.equal(transactions.length, 0);
  assert.equal((await chain.getUtxos([ref])).length, 1);
  await assert.rejects(deploy({ ...o, config: { adminThreshold: 0 } }), /Invalid deployment config/);
  assert.equal(transactions.length, 0);
});

test('OPS-01: mainnet evaluation precedes submission and the caution precedes the first submit', { timeout: 180_000 }, async () => {
  const { o, logs, transactions } = await options(400_000_000n, 'mainnet');
  const submit = o.provider.submit;
  const evaluate = o.provider.evaluate;
  const evaluated = new Set<string>();
  o.provider.evaluate = async (cbor, additional) => {
    const result = await evaluate(cbor, additional);
    if (additional === undefined) evaluated.add(cbor);
    return result;
  };
  o.provider.submit = async cbor => {
    assert.ok(evaluated.has(cbor), 'Evaluate the signed bytes before submission');
    assert.ok(logs.includes('CAUTION: this spends real ADA and cannot be undone.'));
    return submit(cbor);
  };
  await deploy(o);
  assert.equal(transactions.length, 4);
  assert.equal(logs.filter(line => line.startsWith('CAUTION:')).length, 1);
});

test('OPS-02: failed final evaluation aborts before funding', { timeout: 180_000 }, async () => {
  const { o, transactions } = await options();
  const evaluate = o.provider.evaluate;
  o.provider.evaluate = (cbor, additional) => additional === undefined
    ? Promise.reject(new Error('evaluation unavailable')) : evaluate(cbor, additional);
  await assert.rejects(deploy(o), /evaluation unavailable/);
  assert.equal(transactions.length, 0);
});

test('OPS-01: confirmation bounds hanging requests and propagates provider failures', async () => {
  const chain = new FakeChain({ network });
  chain.getUtxos = async () => new Promise<Utxo[]>(() => {});
  await assert.rejects(pollConfirm(chain, { intervalMs: 1, timeoutMs: 10 })('a1'.repeat(32)), /timed out/i);
  chain.getUtxos = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(pollConfirm(chain)('a2'.repeat(32)), /provider unavailable/);
  assert.throws(() => pollConfirm(chain, { intervalMs: 0 }), /positive integer/);
});
