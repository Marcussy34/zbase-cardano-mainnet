import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { vkToCardano, type SnarkjsVk } from '@zbase-cardano/crypto';
import {
  assetWireUnit, blockfrostProvider, buildInit, buildPublishScripts, buildScripts, complete, decodeTx, genesisPoolDatum,
  isAdaAsset, keyHash, newTxBuilder, outputsOf, signTx, vkToHex,
  type AssetClass, type BuiltTx, type ConfigDatum, type Deployment, type Network, type Provider, type Utxo, type UtxoRef,
} from '@zbase-cardano/txlib';
import { readSettings } from './env.js';
import { ROLES, roleAddress, roleKeyHash } from './roles.js';

export interface DeployOptions {
  provider: Provider;
  network: Network;
  operatorSeed: Uint8Array;
  asset?: AssetClass;
  vkeys: { spend: SnarkjsVk; insert: SnarkjsVk; ragequit: SnarkjsVk };
  config?: Partial<ConfigDatum>;
  funding?: Partial<Record<'asp' | 'crank' | 'relayer' | 'user', bigint>>;
  confirm(txId: string): Promise<void>;
  log?: (line: string) => void;
}

type BuildOptions = Omit<DeployOptions, 'confirm'>;
type Stage = 'funding' | 'referenceScripts' | 'pool';
const ADA = 1_000_000n;
const defaultFunding = { asp: 20n * ADA, crank: 30n * ADA, relayer: 30n * ADA, user: 60n * ADA };
const fundedRoles = ['asp', 'crank', 'relayer', 'user'] as const;
const refKey = (ref: UtxoRef): string => `${ref.txId}#${ref.index}`;
const sum = (utxos: Utxo[]): bigint => utxos.reduce((total, u) => total + u.value.lovelace, 0n);
const spendable = (u: Utxo): boolean => u.scriptRef === null && u.inlineDatum === null && u.datumHash === null
  && Object.keys(u.value.assets).length === 0;
const ada = (value: bigint): string => `${value / ADA}.${(value % ADA).toString().padStart(6, '0')}`;

function m0Config(o: BuildOptions, asset: AssetClass): ConfigDatum {
  const config: ConfigDatum = {
    admins: [roleKeyHash(o.operatorSeed, 'admin')], adminThreshold: 1,
    treasury: { payment: { kind: 'key', hash: keyHash(o.operatorSeed) }, stake: null },
    // With six decimals these unchanged limits are 5, 50, and 500 tokens.
    depositsPaused: false, minDeposit: 5n * ADA, maxDeposit: 50n * ADA, poolCap: 500n * ADA,
    // The cranker keeps deposit ADA in a token pool, so Insert ignores this fee.
    depositFeeBps: 0, settleFeeBps: 0, crankFee: isAdaAsset(asset) ? 300_000n : 0n, ...o.config,
  };
  if (!Number.isSafeInteger(config.adminThreshold) || config.adminThreshold < 1 || config.adminThreshold > config.admins.length
    || new Set(config.admins).size !== config.admins.length || config.admins.some(hash => !/^[a-f0-9]{56}$/.test(hash))
    || config.minDeposit <= 0n || config.maxDeposit < config.minDeposit || config.poolCap < config.maxDeposit
    || !Number.isSafeInteger(config.depositFeeBps) || config.depositFeeBps < 0 || config.depositFeeBps > 100
    || !Number.isSafeInteger(config.settleFeeBps) || config.settleFeeBps < 0 || config.settleFeeBps > 1000
    || config.crankFee < 0n || config.crankFee > ADA) throw new Error('Invalid deployment config');
  return config;
}

/** Resume after each confirmation, so every subsequent stage reads confirmed change. */
async function* transactions(o: BuildOptions): AsyncGenerator<{ stage: Stage; tx: BuiltTx }, Deployment> {
  const { provider, network } = o;
  const asset = o.asset ?? { policy: '', name: '' };
  const ctx = { provider, network };
  const address = roleAddress(o.operatorSeed, 'operator', network);
  const payer = async () => ({ address, utxos: (await provider.getUtxosAt(address)).filter(spendable) });
  const funding = { ...defaultFunding, ...o.funding };
  for (const role of fundedRoles) {
    if (typeof funding[role] !== 'bigint' || funding[role] < ADA) throw new Error('Role funding must be at least 1 ADA');
  }
  const config = m0Config(o, asset);
  const spend = vkToCardano(o.vkeys.spend);
  const insert = vkToCardano(o.vkeys.insert);
  const ragequit = vkToCardano(o.vkeys.ragequit);
  const builder = await newTxBuilder(ctx);
  // Index zero is reserved before adding any role outputs or automatic change.
  builder.txOut(address, [{ unit: 'lovelace', quantity: String(5n * ADA) }]);
  for (const role of fundedRoles) {
    const target = roleAddress(o.operatorSeed, role, network);
    builder.txOut(target, [{ unit: 'lovelace', quantity: String(funding[role]) }]);
    builder.txOut(target, [{ unit: 'lovelace', quantity: String(5n * ADA) }]);
  }
  const fundingTx = await complete(ctx, builder, { payer: await payer() });
  yield { stage: 'funding', tx: fundingTx };
  const seed = { txId: fundingTx.txId, index: 0 };
  const scripts = buildScripts({ seed, asset, vkSpend: spend, vkInsert: insert, vkRagequit: ragequit }, { network });
  const publicationPayer = await payer();
  // The NFT seed must survive both reference publication transactions.
  publicationPayer.utxos = publicationPayer.utxos.filter(u => refKey(u.ref) !== refKey(seed));
  const publication = await buildPublishScripts(ctx, {
    payer: publicationPayer, scripts, holder: roleAddress(o.operatorSeed, 'holder', network),
  });
  for (const tx of publication.txs) yield { stage: 'referenceScripts', tx };
  const init = await buildInit(ctx, { payer: await payer(), seed, scripts, config,
    asp: { root: genesisPoolDatum().roots[0]!, operators: [roleKeyHash(o.operatorSeed, 'asp')], threshold: 1, uri: '' },
  });
  yield { stage: 'pool', tx: init };
  return { network, poolId: scripts.poolId, seed, asset, scripts, refScripts: publication.refScripts, initTx: init.txId,
    vkeys: { spend: vkToHex(spend), insert: vkToHex(insert), ragequit: vkToHex(ragequit) } };
}

/** Build on virtual funds, retaining real parameters and real script evaluation. Never submit. */
export async function deployCost(o: BuildOptions): Promise<{ total: bigint; funding: bigint; referenceScripts: bigint; pool: bigint; fees: bigint }> {
  const address = roleAddress(o.operatorSeed, 'operator', o.network);
  const initial: Utxo = { ref: { txId: '00'.repeat(32), index: 0 }, address,
    value: { lovelace: 1_000_000n * ADA, assets: {} }, inlineDatum: null, datumHash: null, scriptRef: null };
  const virtual = new Map([[refKey(initial.ref), initial]]);
  const parameters = await o.provider.getProtocolParameters();
  const provider: Provider = {
    getProtocolParameters: async () => parameters,
    getTip: () => o.provider.getTip(),
    getUtxosAt: async target => [...virtual.values()].filter(u => u.address === target),
    getUtxos: async refs => refs.flatMap(ref => virtual.get(refKey(ref)) ?? []),
    evaluate: (cbor, additional = []) => o.provider.evaluate(cbor, [...virtual.values(), ...additional]),
    submit: async () => { throw new Error('Cost estimation cannot submit transactions'); },
  };
  const costs = { funding: 0n, referenceScripts: 0n, pool: 0n, fees: 0n };
  for await (const { stage, tx } of transactions({ ...o, provider })) {
    const view = decodeTx(tx.cbor);
    const outputs = outputsOf(view);
    costs[stage] += sum(outputs.filter(u => u.address !== address));
    costs.fees += tx.fee;
    for (const input of view.inputs) virtual.delete(refKey(input));
    for (const output of outputs) virtual.set(refKey(output.ref), output);
  }
  // Retain spendable change and allow small input-count or fee differences on the live wallet.
  costs.fees += ADA;
  return { total: costs.funding + costs.referenceScripts + costs.pool + costs.fees, ...costs };
}

/** Fund roles, publish references, initialize state, and return only public deployment data. */
export async function deploy(o: DeployOptions): Promise<Deployment> {
  const cost = await deployCost(o);
  const address = roleAddress(o.operatorSeed, 'operator', o.network);
  const available = sum((await o.provider.getUtxosAt(address)).filter(spendable));
  if (available < cost.total) {
    throw new Error(`Operator ${address} needs ${ada(cost.total)} ADA; available spendable balance is ${ada(available)} ADA`);
  }
  const steps = transactions(o);
  let next = await steps.next();
  let submitted = 0;
  while (!next.done) {
    const { stage, tx } = next.value;
    const signed = signTx(tx.cbor, [o.operatorSeed]);
    // Evaluate the exact signed transaction, including transactions without scripts.
    const measured = await o.provider.evaluate(signed);
    if (measured.length !== tx.exUnits.length || measured.some(unit => {
      const declared = tx.exUnits.find(r => r.tag === unit.tag && r.index === unit.index);
      return !declared || unit.mem < 0n || unit.steps < 0n || unit.mem > declared.mem || unit.steps > declared.steps;
    })) throw new Error('Final deployment evaluation differs from the declared budget');
    if (submitted === 0 && o.network === 'mainnet') (o.log ?? console.warn)('CAUTION: this spends real ADA and cannot be undone.');
    const id = await o.provider.submit(signed);
    submitted++;
    o.log?.(`${stage} transaction ${id}`);
    if (id !== tx.txId) throw new Error('Provider returned a different transaction ID');
    await o.confirm(id);
    next = await steps.next();
  }
  return next.value;
}

/** A provider error is actionable; only an absent output is retried. */
export function pollConfirm(provider: Provider, a: { intervalMs?: number; timeoutMs?: number } = {}): (txId: string) => Promise<void> {
  const intervalMs = a.intervalMs ?? 5_000;
  const timeoutMs = a.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Confirmation intervals must be positive integer milliseconds');
  }
  return async txId => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Confirmation timed out for ${txId}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Confirmation timed out for ${txId}`)), remaining);
      });
      let utxos: Utxo[];
      try { utxos = await Promise.race([provider.getUtxos([{ txId, index: 0 }]), timeout]); }
      finally { clearTimeout(timer); }
      if (utxos.some(u => u.ref.txId === txId && u.ref.index === 0)) return;
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  };
}

/** Injectable boundaries let the command run against the in-memory chain without credentials. */
export async function runDeployCommand(a: {
  argv?: string[]; env?: Record<string, string | undefined>; repoRoot?: string;
  provider?: Provider; confirm?: (txId: string) => Promise<void>; log?: (line: string) => void;
} = {}): Promise<void> {
  const { values } = parseArgs({ args: a.argv ?? process.argv.slice(2), options: {
    'dev-keys': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    out: { type: 'string' }, force: { type: 'boolean', default: false },
  } });
  const settings = readSettings(a.env);
  const root = a.repoRoot ?? fileURLToPath(new URL('../../', import.meta.url));
  const log = a.log ?? console.log;
  const output = resolve(values.out ?? join(root, `deployments/${settings.network}.json`));
  if (!values['dry-run']) {
    if (!values.force) {
      // Exclusive creation below also protects against a concurrent writer after this check.
      try {
        await access(output);
        throw new Error('Deployment record already exists. Use --force to replace it.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await mkdir(dirname(output), { recursive: true });
  }
  const keyDir = join(root, values['dev-keys'] ? 'artifacts/dev' : `deployments/${settings.network}/keys`);
  const readKey = async (circuit: string): Promise<SnarkjsVk> => JSON.parse(await readFile(join(keyDir, `${circuit}_vkey.json`), 'utf8'));
  const [spend, insert, ragequit] = await Promise.all(['spend', 'insert', 'ragequit'].map(readKey));
  const provider = a.provider ?? blockfrostProvider(settings.blockfrostProjectId, settings.network);
  const o: BuildOptions = { provider, network: settings.network, operatorSeed: settings.operatorSeed, asset: settings.asset,
    vkeys: { spend: spend!, insert: insert!, ragequit: ragequit! }, log };
  if (values['dry-run']) {
    log(`pool asset: ${assetWireUnit(settings.asset)}`);
    if (!isAdaAsset(settings.asset)) log('fund the user role with the pool token before the demo');
    for (const role of ROLES) log(`${role}: ${roleAddress(settings.operatorSeed, role, settings.network)}`);
    const cost = await deployCost(o);
    for (const [name, value] of Object.entries(cost)) log(`${name}: ${ada(value)} ADA`);
    const address = roleAddress(settings.operatorSeed, 'operator', settings.network);
    log(`operator balance: ${ada(sum((await provider.getUtxosAt(address)).filter(spendable)))} ADA spendable`);
    return;
  }
  const record = await deploy({ ...o, confirm: a.confirm ?? pollConfirm(provider) });
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { flag: values.force ? 'w' : 'wx' });
  log(`Deployment record: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runDeployCommand(); }
  catch (error) {
    let message = error instanceof Error ? error.message : 'Deployment failed';
    for (const secret of [process.env.OPERATOR_SEED_HEX, process.env.BLOCKFROST_PROJECT_ID]) {
      if (secret) for (const value of [secret, secret.toLowerCase(), secret.toUpperCase()]) message = message.split(value).join('[redacted]');
    }
    console.error(message);
    process.exitCode = 1;
  }
}
