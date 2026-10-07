import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addressToBech32 } from '@zbase-cardano/crypto';
import {
  assetAmount, assetWireUnit, blockfrostProvider, buildCollectFees, buildConfigUpdate, complete, isAdaAsset, newTxBuilder,
  readConfig, readPool, signTx, utxoToMesh,
  type BuiltTx, type ChainContext, type Deployment, type Utxo,
} from '@zbase-cardano/txlib';
import { pollConfirm } from './deploy.js';
import { readSettings } from './env.js';
import { ROLES, roleAddress, roleKeyHash, roleSeed } from './roles.js';

export interface AdminOptions {
  ctx: ChainContext;
  operatorSeed: Uint8Array;
  confirm?: (txId: string) => Promise<void>;
  log?: (line: string) => void;
}

const sum = (utxos: Utxo[]): bigint => utxos.reduce((total, u) => total + u.value.lovelace, 0n);
const payer = (o: AdminOptions) => ({ address: roleAddress(o.operatorSeed, 'operator', o.ctx.deployment.network) });
const json = (value: unknown): string => JSON.stringify(value, (_, field: unknown) => typeof field === 'bigint' ? String(field) : field);
const sweepCaution = 'CAUTION: sweeping reference scripts disables this pool. Pause deposits, exit all notes, and collect fees first.';

/** Check the exact signed bytes, including reference-script fees, before any submission. */
async function submit(o: AdminOptions, tx: BuiltTx, seeds: Uint8Array[], action: string): Promise<{ txId: string }> {
  const signed = signTx(tx.cbor, seeds);
  const measured = await o.ctx.provider.evaluate(signed);
  if (measured.length !== tx.exUnits.length || new Set(measured.map(unit => `${unit.tag}:${unit.index}`)).size !== measured.length
    || measured.some(unit => {
      const declared = tx.exUnits.find(r => r.tag === unit.tag && r.index === unit.index);
      return !declared || unit.mem < 0n || unit.steps < 0n || unit.mem > declared.mem || unit.steps > declared.steps;
    })) throw new Error('Final admin evaluation differs from the declared budget');
  if (o.ctx.deployment.network === 'mainnet') (o.log ?? console.warn)('CAUTION: this spends real ADA and cannot be undone.');
  const txId = await o.ctx.provider.submit(signed);
  o.log?.(`${action} transaction ${txId}`);
  if (txId !== tx.txId) throw new Error('Provider returned a different transaction ID');
  await o.confirm?.(txId);
  return { txId };
}

/** Public facts only: the pool and config values, and every role address with its balance. Never a seed. */
export async function status(o: AdminOptions): Promise<string[]> {
  const { network, poolId, asset } = o.ctx.deployment;
  const unit = assetWireUnit(asset);
  const [pool, config] = await Promise.all([readPool(o.ctx), readConfig(o.ctx)]);
  const lines = [
    `pool: ${json({ poolId, network, address: pool.utxo.address, ref: pool.utxo.ref, balance: `${pool.balance} ${unit}`, ...pool.datum })}`,
    `pool ada: ${pool.utxo.value.lovelace} lovelace`,
    `config: ${json({ address: config.utxo.address, ref: config.utxo.ref, ...config.datum, treasury: addressToBech32(config.datum.treasury, network) })}`,
    ...await Promise.all(ROLES.map(async role => {
      const address = roleAddress(o.operatorSeed, role, network);
      const utxos = await o.ctx.provider.getUtxosAt(address);
      const tokens = isAdaAsset(asset) ? '' : `, ${utxos.reduce((total, u) => total + assetAmount(u.value, asset), 0n)} ${unit}`;
      return `${role}: ${address} balance ${sum(utxos)} lovelace${tokens}`;
    })),
  ];
  for (const line of lines) o.log?.(line);
  return lines;
}

/** Returns null when deposits already are in that state. The operator pays, the admin role key signs. */
export async function setDepositsPaused(o: AdminOptions & { paused: boolean }): Promise<{ txId: string } | null> {
  const { datum } = await readConfig(o.ctx);
  if (datum.depositsPaused === o.paused) {
    o.log?.(`Deposits already ${o.paused ? 'paused' : 'unpaused'}.`);
    return null;
  }
  const tx = await buildConfigUpdate(o.ctx, { payer: payer(o), config: { ...datum, depositsPaused: o.paused },
    signers: [roleKeyHash(o.operatorSeed, 'admin')] });
  return submit(o, tx, [roleSeed(o.operatorSeed, 'operator'), roleSeed(o.operatorSeed, 'admin')], o.paused ? 'pause' : 'unpause');
}

/** Collects amount, or everything accrued. Returns null when nothing is accrued. */
export async function collectFees(o: AdminOptions & { amount?: bigint }): Promise<{ txId: string; amount: bigint } | null> {
  const { datum } = await readPool(o.ctx);
  if (datum.feesAccrued === 0n) {
    o.log?.('No accrued fees to collect.');
    return null;
  }
  const amount = o.amount ?? datum.feesAccrued;
  const tx = await buildCollectFees(o.ctx, { payer: payer(o), amount });
  return { ...await submit(o, tx, [roleSeed(o.operatorSeed, 'operator')], 'collect-fees'), amount };
}

/** Wind-down only: spends the reference script outputs of this pool at the holder address back to the operator. */
export async function sweepReferences(o: AdminOptions): Promise<{ txId: string; lovelace: bigint } | null> {
  const { provider, deployment: { network, refScripts } } = o.ctx;
  const holder = roleAddress(o.operatorSeed, 'holder', network);
  // Every pool of one operator publishes at the same holder address. Take only this pool's outputs.
  const own = new Set(Object.values(refScripts).map(ref => `${ref.txId}#${ref.index}`));
  const references = (await provider.getUtxosAt(holder)).filter(u => u.scriptRef !== null && own.has(`${u.ref.txId}#${u.ref.index}`));
  if (references.length === 0) {
    o.log?.('No reference script outputs to sweep.');
    return null;
  }
  (o.log ?? console.warn)(sweepCaution);
  const builder = await newTxBuilder({ provider, network });
  for (const utxo of references) {
    builder.txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, utxo.scriptRef!.size);
  }
  // Reserve both witnesses even when the holder inputs cover the whole transaction fee.
  for (const role of ['holder', 'operator'] as const) builder.requiredSignerHash(roleKeyHash(o.operatorSeed, role));
  const tx = await complete({ provider, network }, builder, { payer: payer(o), extraUtxos: references });
  const result = await submit(o, tx, [roleSeed(o.operatorSeed, 'operator'), roleSeed(o.operatorSeed, 'holder')], 'sweep-references');
  return { ...result, lovelace: sum(references) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { yes: { type: 'boolean', default: false } } });
    const [command, rawAmount] = positionals;
    if (command === 'sweep-references' && !values.yes) {
      console.warn(sweepCaution);
      throw new Error('sweep-references requires --yes');
    }
    if (!command || !['status', 'pause', 'unpause', 'collect-fees', 'sweep-references'].includes(command)
      || positionals.length > (command === 'collect-fees' ? 2 : 1)
      || (values.yes && command !== 'sweep-references')) {
      throw new Error('Usage: admin status | pause | unpause | collect-fees [pool asset units] | sweep-references --yes');
    }
    if (rawAmount !== undefined && !/^[0-9]+$/.test(rawAmount)) throw new Error('Fee amount must be a positive integer in pool asset units');
    const amount = rawAmount === undefined ? undefined : BigInt(rawAmount);
    if (amount !== undefined && amount <= 0n) throw new Error('Fee amount must be positive in pool asset units');
    const settings = readSettings();
    const deployment = JSON.parse(await readFile(new URL(`../../deployments/${settings.network}.json`, import.meta.url), 'utf8')) as Deployment;
    if (deployment.network !== settings.network) throw new Error('Deployment network does not match NETWORK');
    const provider = blockfrostProvider(settings.blockfrostProjectId, settings.network);
    const o: AdminOptions = { ctx: { provider, deployment }, operatorSeed: settings.operatorSeed,
      confirm: pollConfirm(provider), log: console.log };
    if (command === 'status') await status(o);
    else if (command === 'pause' || command === 'unpause') await setDepositsPaused({ ...o, paused: command === 'pause' });
    else if (command === 'collect-fees') await collectFees({ ...o, amount });
    else await sweepReferences(o);
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Admin command failed';
    const secrets = [process.env.OPERATOR_SEED_HEX, process.env.BLOCKFROST_PROJECT_ID];
    const seed = process.env.OPERATOR_SEED_HEX;
    if (seed && /^[a-fA-F0-9]{64}$/.test(seed)) {
      for (const role of ROLES) secrets.push(Buffer.from(roleSeed(Buffer.from(seed, 'hex'), role)).toString('hex'));
    }
    for (const secret of secrets) {
      if (secret) for (const value of [secret, secret.toLowerCase(), secret.toUpperCase()]) message = message.split(value).join('[redacted]');
    }
    console.error(message);
    process.exitCode = 1;
  }
}
