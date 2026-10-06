import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fromJsonToPlutusData, normalizePlutusScript, toScriptRef } from '@meshsdk/core-cst';
import type { CardanoVk } from '@zbase-cardano/crypto';
import { buildScripts, type ScriptParams } from '../src/scripts.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const blueprint = JSON.parse(readFileSync(join(root, 'contracts/plutus.json'), 'utf8')) as {
  validators: { title: string; compiledCode: string; hash: string }[];
};
const hasPool = blueprint.validators.some(validator => validator.title === 'pool.pool.spend');
const poolOptions = { skip: hasPool ? false : 'pool.pool.spend is not in the blueprint yet' };
const point = (length: number, fill: number) => new Uint8Array(length).fill(fill);
// These bytes exercise parameter serialization, not proof verification.
// Point sizes and input counts match the real keys, and every key differs so a swapped order shows.
const key = (fill: number, publicInputs: number): CardanoVk => ({
  alpha: point(48, fill), beta: point(96, fill + 1), gamma: point(96, fill + 2), delta: point(96, fill + 3),
  ic: Array.from({ length: publicInputs + 1 }, (_, i) => point(48, fill + 4 + i)),
});
const params: ScriptParams = {
  seed: { txId: 'ab'.repeat(32), index: 3 }, asset: { policy: '', name: '' },
  vkSpend: key(0x10, 6), vkInsert: key(0x40, 15), vkRagequit: key(0x80, 4),
};
const names = ['nft', 'deposit', 'config', 'asp', 'pool'] as const;

test('TX-01: scripts are deterministic, network independent, and seed dependent', poolOptions, () => {
  const mainnet = buildScripts(params);
  assert.deepEqual(buildScripts(params), mainnet);
  assert.deepEqual(buildScripts(params, { blueprint }), mainnet);
  const preprod = buildScripts(params, { network: 'preprod', blueprint });
  const another = buildScripts({ ...params, seed: { ...params.seed, index: 4 } }, { blueprint });
  assert.equal(new Set(names.map(name => mainnet[name].hash)).size, 5);
  assert.equal(mainnet.poolId, mainnet.nft.hash);
  assert.equal(mainnet.nft.address, '');
  assert.equal(preprod.nft.address, '');
  for (const name of names) {
    assert.match(mainnet[name].hash, /^[0-9a-f]{56}$/);
    assert.equal(mainnet[name].hash, preprod[name].hash);
    assert.equal(mainnet[name].cbor, preprod[name].cbor);
    assert.notEqual(mainnet[name].hash, another[name].hash);
    if (name !== 'nft') {
      assert.match(mainnet[name].address, /^addr1w/);
      assert.match(preprod[name].address, /^addr_test1w/);
    }
  }
});

test('TX-01: script sizes count ledger bytes and exclude the outer Mesh wrapper', poolOptions, () => {
  const scripts = buildScripts(params, { blueprint });
  for (const name of names) {
    const info = scripts[name];
    const script = toScriptRef({ code: info.cbor, version: 'V3' });
    assert.equal(script.hash(), info.hash);
    assert.equal(info.size, script.asPlutusV3()!.rawBytes().length / 2);
    assert.equal(info.size, normalizePlutusScript(info.cbor, 'SingleCBOR').length / 2);
    assert.ok(info.size < info.cbor.length / 2);
  }
});

test('TX-01: Aiken applies the same parameters to all five scripts', poolOptions, () => {
  const buildDir = join(root, 'packages/txlib/build');
  mkdirSync(buildDir, { recursive: true });
  const dir = mkdtempSync(join(buildDir, 'codec-scripts-'));
  try {
    writeFileSync(join(dir, 'plutus.json'), JSON.stringify(blueprint));
    // The hash subcommand reads the manifest even when the blueprint is supplied.
    copyFileSync(join(root, 'contracts/aiken.toml'), join(dir, 'aiken.toml'));
    const aiken = join(root, 'node_modules/.bin/aiken');
    const scripts = buildScripts(params, { blueprint });
    const cbor = (json: Parameters<typeof fromJsonToPlutusData>[0]) => fromJsonToPlutusData(json).toCbor();
    const hexOf = (value: Uint8Array) => Buffer.from(value).toString('hex');
    const keyCbor = (vk: CardanoVk) => cbor({ constructor: 0, fields: [
      { bytes: hexOf(vk.alpha) }, { bytes: hexOf(vk.beta) }, { bytes: hexOf(vk.gamma) }, { bytes: hexOf(vk.delta) },
      { list: vk.ic.map(value => ({ bytes: hexOf(value) })) },
    ] });
    const policy = cbor({ bytes: scripts.nft.hash });
    const parameters: Record<(typeof names)[number], string[]> = {
      nft: [cbor({ constructor: 0, fields: [{ bytes: params.seed.txId }, { int: params.seed.index }] })],
      deposit: [policy], config: [policy], asp: [policy],
      // The keys hold 96-byte points, which Plutus data must split into 64-byte chunks.
      // Mesh 1.9.1 truncated them, so every pool parameter is compared with Aiken here.
      pool: [
        policy, cbor({ bytes: scripts.deposit.hash }),
        cbor({ constructor: 0, fields: [{ bytes: params.asset.policy }, { bytes: params.asset.name }] }),
        keyCbor(params.vkSpend), keyCbor(params.vkInsert), keyCbor(params.vkRagequit),
      ],
    };
    for (const name of names) {
      // Aiken applies one parameter per call, so chain the output files.
      let file = 'plutus.json';
      parameters[name].forEach((argument, i) => {
        const output = `${name}-${i}.json`;
        execFileSync(aiken, ['blueprint', 'apply', '-i', file, '-o', output, '-m', name, '-v', name, argument], {
          cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 30000,
        });
        file = output;
      });
      const applied = JSON.parse(readFileSync(join(dir, file), 'utf8')) as typeof blueprint;
      const title = name === 'nft' ? 'nft.nft.mint' : `${name}.${name}.spend`;
      const validator = applied.validators.find(validator => validator.title === title)!;
      assert.equal(validator.hash, scripts[name].hash);
      assert.equal(normalizePlutusScript(validator.compiledCode, 'DoubleCBOR'), scripts[name].cbor);
      const hash = execFileSync(aiken, ['blueprint', 'hash', '-i', file, '-m', name, '-v', name], {
        cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 30000,
      }).trim();
      assert.equal(hash, scripts[name].hash);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TX-01: a missing validator is named in the error', () => {
  for (const title of ['nft.nft.mint', 'deposit.deposit.spend', 'config.config.spend', 'asp.asp.spend', 'pool.pool.spend']) {
    const incomplete = { ...blueprint, validators: blueprint.validators.filter(validator => validator.title !== title) };
    assert.throws(() => buildScripts(params, { blueprint: incomplete }), error => error instanceof Error && error.message.includes(title));
  }
});
