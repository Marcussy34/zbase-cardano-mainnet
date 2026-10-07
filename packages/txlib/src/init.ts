import { toTxUnspentOutput } from '@meshsdk/core-cst';
import { ZERO_HASHES } from '@zx402/crypto';
import { complete, newTxBuilder, type Deployment, type Payer } from './context.js';
import { encodeAspDatum, encodeConfigDatum, encodePoolDatum, encodeVoid, type AspDatum, type ConfigDatum, type PoolDatum } from './codec.js';
import { utxoToMesh } from './providers/blockfrost.js';
import type { PoolScripts } from './scripts.js';
import { decodeTx, outputsOf } from './txview.js';
import type { BuiltTx, Network, Provider, Utxo, UtxoRef } from './types.js';

export const POOL_RESERVE = 6_000_000n;
type Context = { provider: Provider; network: Network };

export function genesisPoolDatum(): PoolDatum {
  return { roots: [ZERO_HASHES[32]!], size: 0, queue: [], nullifierRoot: '00'.repeat(32), feesAccrued: 0n };
}

/** Fix the lovelace field width before measuring the ledger output bytes. */
export function minimumLovelace(output: ReturnType<typeof utxoToMesh>['output'], coinsPerByte: bigint): bigint {
  let minimum = 0n;
  for (;;) {
    const amount = [{ unit: 'lovelace', quantity: String(minimum) }, ...output.amount.filter(a => a.unit !== 'lovelace')];
    const bytes = toTxUnspentOutput({ input: { txHash: '00'.repeat(32), outputIndex: 0 }, output: { ...output, amount } }).output().toCbor().length / 2;
    const next = coinsPerByte * BigInt(160 + bytes);
    if (next === minimum) return minimum;
    minimum = next;
  }
}

export async function buildPublishScripts(ctx: Context, a: { payer: Payer; scripts: PoolScripts; holder: string }): Promise<{ txs: BuiltTx[]; refScripts: Deployment['refScripts'] }> {
  const coinsPerByte = (await ctx.provider.getProtocolParameters()).coinsPerUtxoByte;
  const txs: BuiltTx[] = [];
  const refScripts = {} as Deployment['refScripts'];
  let payer = { address: a.payer.address, utxos: a.payer.utxos ?? await ctx.provider.getUtxosAt(a.payer.address) };
  let chained: Utxo[] = [];
  for (const names of [['pool'], ['deposit', 'config', 'asp']] as const) {
    const builder = await newTxBuilder(ctx);
    for (const utxo of chained) {
      builder.txIn(utxo.ref.txId, utxo.ref.index, utxoToMesh(utxo).output.amount, utxo.address, 0);
    }
    for (const name of names) {
      // Let Mesh encode the language-tagged script before measuring its output.
      builder.txOut(a.holder, [{ unit: 'lovelace', quantity: '0' }]).txOutReferenceScript(a.scripts[name].cbor, 'V3');
    }
    const raw = outputsOf(decodeTx(builder.completeSync()));
    raw.forEach((output, index) => {
      builder.meshTxBuilderBody.outputs[index]!.amount = [{ unit: 'lovelace', quantity: String(minimumLovelace(utxoToMesh(output).output, coinsPerByte)) }];
    });
    const tx = await complete(ctx, builder, { payer });
    txs.push(tx);
    names.forEach((name, index) => { refScripts[name] = { txId: tx.txId, index }; });
    const view = decodeTx(tx.cbor);
    const spent = new Set(view.inputs.map(ref => `${ref.txId}#${ref.index}`));
    // Keep unused funding alongside change, but never spend published script outputs.
    chained = outputsOf(view).slice(names.length).filter(u => u.address === a.payer.address);
    payer = { address: a.payer.address, utxos: [...payer.utxos.filter(u => !spent.has(`${u.ref.txId}#${u.ref.index}`)), ...chained] };
  }
  return { txs, refScripts };
}

export async function buildInit(ctx: Context, a: { payer: Payer; seed: UtxoRef; scripts: PoolScripts; config: ConfigDatum; asp: AspDatum }): Promise<BuiltTx> {
  const available = a.payer.utxos ?? await ctx.provider.getUtxosAt(a.payer.address);
  const seed = available.find(u => u.ref.txId === a.seed.txId && u.ref.index === a.seed.index && u.address === a.payer.address);
  if (!seed) throw new Error('Payer must own the Init seed UTXO');
  const builder = await newTxBuilder(ctx);
  const coinsPerByte = (await ctx.provider.getProtocolParameters()).coinsPerUtxoByte;
  builder.txIn(seed.ref.txId, seed.ref.index, utxoToMesh(seed).output.amount, seed.address, seed.scriptRef?.size ?? 0);
  for (const name of ['pool', 'config', 'asp']) {
    builder.mintPlutusScriptV3().mint('1', a.scripts.poolId, Buffer.from(name).toString('hex'))
      .mintingScript(a.scripts.nft.cbor).mintRedeemerValue(encodeVoid(), 'CBOR');
  }
  const datums = { pool: encodePoolDatum(genesisPoolDatum()), config: encodeConfigDatum(a.config), asp: encodeAspDatum(a.asp) };
  for (const name of ['pool', 'config', 'asp'] as const) {
    const output = { address: a.scripts[name].address,
      amount: [{ unit: a.scripts.poolId + Buffer.from(name).toString('hex'), quantity: '1' }], plutusData: datums[name] };
    const lovelace = name === 'pool' ? POOL_RESERVE : minimumLovelace(output, coinsPerByte);
    builder.txOut(output.address, [{ unit: 'lovelace', quantity: String(lovelace) }, ...output.amount]).txOutInlineDatumValue(output.plutusData, 'CBOR');
  }
  return complete(ctx, builder, { payer: { ...a.payer, utxos: available } });
}
