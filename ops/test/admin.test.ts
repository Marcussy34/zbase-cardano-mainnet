import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SnarkjsVk } from '@zx402/crypto';
import { decodeTx, readConfig, type AssetClass, type Network, type Utxo } from '@zx402/txlib';
import { FakeChain } from '@zx402/txlib/testing/fake-chain';
import { deploy } from '../src/deploy.js';
import { ROLES, roleAddress, roleKeyHash, roleSeed } from '../src/roles.js';

const operatorSeed = new Uint8Array(32).fill(29);
const tokenAsset = { policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde', name: '0014df10745553444d' };
const tokenUnit = `${tokenAsset.policy}.${tokenAsset.name}`;
const sum = (utxos: Utxo[]): bigint => utxos.reduce((total, u) => total + u.value.lovelace, 0n);

async function setup(network: Network = 'preprod', asset: AssetClass = { policy: '', name: '' }) {
  const chain = new FakeChain({ network });
  chain.addUtxo({ address: roleAddress(operatorSeed, 'operator', network), value: { lovelace: 400_000_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null });
  const keys = await Promise.all(['spend', 'insert', 'ragequit'].map(async name =>
    JSON.parse(await readFile(new URL(`../../artifacts/dev/${name}_vkey.json`, import.meta.url), 'utf8')) as SnarkjsVk));
  const confirm = async (id: string) => { assert.deepEqual(chain.mineBlock().txIds, [id]); };
  const deployment = await deploy({ provider: chain, network, operatorSeed, asset, confirm, log: () => {},
    vkeys: { spend: keys[0]!, insert: keys[1]!, ragequit: keys[2]! } });
  const logs: string[] = [];
  const confirmed: string[] = [];
  const o = { ctx: { provider: chain, deployment }, operatorSeed,
    confirm: async (id: string) => { await confirm(id); confirmed.push(id); }, log: (line: string) => logs.push(line) };
  return { chain, o, logs, confirmed };
}

test('OPS-ADM-01: pause is idempotent, uses role signatures, and status exposes only public facts', { timeout: 180_000 }, async () => {
  const { setDepositsPaused, status } = await import('../src/admin.js');
  const { chain, o, logs, confirmed } = await setup();
  const result = await setDepositsPaused({ ...o, paused: true });
  assert.ok(result);
  assert.deepEqual(confirmed, [result.txId]);
  assert.equal((await readConfig(o.ctx)).datum.depositsPaused, true);
  assert.equal(await setDepositsPaused({ ...o, paused: true }), null);
  const view = decodeTx(chain.transaction(result.txId)!.cbor);
  assert.ok(view.witnessKeyHashes.includes(roleKeyHash(operatorSeed, 'admin')));
  assert.ok(view.witnessKeyHashes.includes(roleKeyHash(operatorSeed, 'operator')));
  assert.equal(view.witnessKeyHashes.length, 2);
  assert.equal((await chain.getUtxosAt(roleAddress(operatorSeed, 'admin', 'preprod'))).length, 0);
  const lines = await status(o);
  const text = lines.join('\n');
  assert.match(text, /"balance":"6000000 lovelace"/);
  assert.ok(lines.includes('pool ada: 6000000 lovelace'));
  assert.match(text, /depositsPaused.*true/);
  for (const field of ['poolId', 'balance', 'roots', 'size', 'queue', 'nullifierRoot', 'feesAccrued',
    'admins', 'adminThreshold', 'treasury', 'minDeposit', 'maxDeposit', 'poolCap', 'depositFeeBps', 'settleFeeBps', 'crankFee']) assert.ok(text.includes(field), field);
  for (const role of ROLES) {
    const address = roleAddress(operatorSeed, role, 'preprod');
    const line = lines.find(line => line.includes(role) && line.includes(address));
    assert.ok(line, `Missing ${role} balance`);
    assert.ok(line.includes(String(sum(await chain.getUtxosAt(address)))));
    const secret = Buffer.from(roleSeed(operatorSeed, role)).toString('hex');
    assert.ok(![...lines, ...logs].join('\n').toLowerCase().includes(secret));
  }
  assert.deepEqual(confirmed, [result.txId], 'Status and repeated pauses cannot submit');
  assert.ok(await setDepositsPaused({ ...o, paused: false }));
  assert.equal((await readConfig(o.ctx)).datum.depositsPaused, false);
});

test('TOKEN-19: status of a token pool', { timeout: 180_000 }, async () => {
  const { status } = await import('../src/admin.js');
  const { chain, o, logs, confirmed } = await setup('preprod', tokenAsset);
  const user = roleAddress(operatorSeed, 'user', 'preprod');
  chain.addUtxo({ address: user,
    value: { lovelace: 2_000_000n, assets: { [tokenAsset.policy + tokenAsset.name]: 12_345_678n, ['ab'.repeat(28)]: 99n } },
    inlineDatum: null, datumHash: null, scriptRef: null });
  const before = chain.allUtxos();
  const lines = await status(o);
  assert.ok(lines[0]!.includes(`"balance":"0 ${tokenUnit}"`));
  assert.ok(lines.includes('pool ada: 6000000 lovelace'));
  assert.ok(lines.includes(`user: ${user} balance 67000000 lovelace, 12345678 ${tokenUnit}`));
  const admin = roleAddress(operatorSeed, 'admin', 'preprod');
  assert.ok(lines.includes(`admin: ${admin} balance 0 lovelace, 0 ${tokenUnit}`));
  assert.deepEqual(logs, lines);
  assert.deepEqual(confirmed, []);
  assert.deepEqual(chain.allUtxos(), before);
  for (const role of ROLES) assert.ok(!lines.join('\n').includes(Buffer.from(roleSeed(operatorSeed, role)).toString('hex')));
});

test('TOKEN-19: collect-fees usage and invalid amounts name pool asset units', async () => {
  const script = fileURLToPath(new URL('../src/admin.ts', import.meta.url));
  for (const args of [[], ['collect-fees', 'abc'], ['collect-fees', '0']]) {
    // Parsing fails before credentials or a provider are needed.
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', script, ...args], { env: {} }),
      (error: unknown) => {
        const failure = error as { code: number; stderr: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr, /pool asset units/);
        assert.doesNotMatch(failure.stderr, /lovelace/);
        return true;
      });
  }
});

test('OPS-ADM-02: empty accrued fees return null without submission or confirmation', { timeout: 180_000 }, async () => {
  const { collectFees } = await import('../src/admin.js');
  const { o, confirmed, chain } = await setup();
  const before = chain.allUtxos();
  assert.equal(await collectFees(o), null);
  assert.deepEqual(confirmed, []);
  assert.deepEqual(chain.allUtxos(), before);
});

test('OPS-ADM-03: sweep returns reference funds minus fees and preserves ordinary holder outputs', { timeout: 180_000 }, async () => {
  const { sweepReferences } = await import('../src/admin.js');
  const { o, chain, confirmed, logs } = await setup();
  const holder = roleAddress(operatorSeed, 'holder', 'preprod');
  const operator = roleAddress(operatorSeed, 'operator', 'preprod');
  const ordinary = chain.addUtxo({ address: holder, value: { lovelace: 3_000_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: null });
  const references = (await chain.getUtxosAt(holder)).filter(u => u.scriptRef !== null);
  assert.equal(references.length, 4);
  const balance = sum(await chain.getUtxosAt(operator));
  const result = await sweepReferences(o);
  assert.ok(result);
  assert.equal(result.lovelace, sum(references));
  assert.deepEqual(confirmed, [result.txId]);
  const view = decodeTx(chain.transaction(result.txId)!.cbor);
  assert.equal(sum(await chain.getUtxosAt(operator)), balance + result.lovelace - view.fee);
  assert.deepEqual((await chain.getUtxosAt(holder)).map(u => u.ref), [ordinary]);
  assert.ok(view.witnessKeyHashes.includes(roleKeyHash(operatorSeed, 'holder')));
  assert.equal(await sweepReferences(o), null);
  assert.equal(confirmed.length, 1);
  assert.ok(logs.some(line => line.startsWith('CAUTION:')));
});

test('OPS-ADM-03: sweep leaves the reference outputs of another pool at the same holder key', { timeout: 180_000 }, async () => {
  const { sweepReferences } = await import('../src/admin.js');
  const { o, chain } = await setup();
  const holder = roleAddress(operatorSeed, 'holder', 'preprod');
  const own = (await chain.getUtxosAt(holder)).filter(u => u.scriptRef !== null);
  // Every pool of one operator publishes its reference scripts at the same holder address.
  const foreign = chain.addUtxo({ address: holder, value: { lovelace: 20_000_000n, assets: {} },
    inlineDatum: null, datumHash: null, scriptRef: own[0]!.scriptRef });
  const result = await sweepReferences(o);
  assert.ok(result);
  assert.equal(result.lovelace, sum(own));
  assert.deepEqual((await chain.getUtxosAt(holder)).map(u => u.ref), [foreign]);
});

test('OPS-ADM-01: final evaluation precedes mainnet submission and a failure cannot submit', { timeout: 180_000 }, async () => {
  const { setDepositsPaused } = await import('../src/admin.js');
  const { o, chain, logs } = await setup('mainnet');
  const evaluate = chain.evaluate.bind(chain);
  const submit = chain.submit.bind(chain);
  const evaluated = new Set<string>();
  let submissions = 0;
  chain.evaluate = async (cbor, additional) => {
    const result = await evaluate(cbor, additional);
    if (additional === undefined) evaluated.add(cbor);
    return result;
  };
  chain.submit = async cbor => {
    assert.ok(evaluated.has(cbor), 'Evaluate the exact signed bytes before submission');
    assert.equal(logs.filter(line => line.startsWith('CAUTION:')).length, 1);
    submissions++;
    return submit(cbor);
  };
  await setDepositsPaused({ ...o, paused: true });
  chain.evaluate = (cbor, additional) => additional === undefined
    ? Promise.reject(new Error('Final evaluation unavailable')) : evaluate(cbor, additional);
  await assert.rejects(setDepositsPaused({ ...o, paused: false }), /Final evaluation unavailable/);
  assert.equal(submissions, 1);
  assert.equal((await readConfig(o.ctx)).datum.depositsPaused, true);
});
