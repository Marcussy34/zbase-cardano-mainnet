import { readFile } from 'node:fs/promises';
import { vkToCardano } from '@zbase-cardano/crypto';
import { vkToHex, type ChainContext } from '../context.js';
import { buildInit, buildPublishScripts, genesisPoolDatum } from '../init.js';
import { enterpriseAddress, keyHash, signTx } from '../keys.js';
import { buildScripts } from '../scripts.js';
import type { BuiltTx, Network, UtxoRef } from '../types.js';
import { FakeChain } from './fake-chain.js';

export interface Devnet {
  chain: FakeChain;
  ctx: ChainContext;
  keys: { operator: Uint8Array; relayer: Uint8Array; crank: Uint8Array; asp: Uint8Array; admin: Uint8Array[]; users: Uint8Array[] };
  run(tx: BuiltTx, seeds: Uint8Array[]): Promise<string>;
}

/** A deterministic local chain with throwaway keys and the M0 ADA config. */
export async function startDevnet(options: { network?: Network; users?: number } = {}): Promise<Devnet> {
  const network = options.network ?? 'preprod';
  const users = options.users ?? 3;
  if (!Number.isSafeInteger(users) || users < 0 || users > 10_000) throw new RangeError('users must be between 0 and 10000');
  const seed = (id: number): Uint8Array => {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(28, id);
    return bytes;
  };
  const keys = { operator: seed(1), relayer: seed(2), crank: seed(3), asp: seed(4), admin: [seed(5)],
    users: Array.from({ length: users }, (_, index) => seed(index + 6)) };
  const chain = new FakeChain({ network });
  let initSeed: UtxoRef | undefined;
  for (const key of [keys.operator, keys.relayer, keys.crank, keys.asp, ...keys.admin, ...keys.users]) {
    for (const lovelace of [5_000_000n, 1_000_000_000n, 1_000_000_000n]) {
      const ref = chain.addUtxo({ address: enterpriseAddress(key, network), value: { lovelace, assets: {} },
        inlineDatum: null, datumHash: null, scriptRef: null });
      if (key === keys.operator && lovelace > 5_000_000n && initSeed === undefined) initSeed = ref;
    }
  }
  const vkeys = await Promise.all(['spend', 'insert', 'ragequit'].map(async name =>
    vkToCardano(JSON.parse(await readFile(new URL(`../../../../artifacts/dev/${name}_vkey.json`, import.meta.url), 'utf8')))));
  const [vkSpend, vkInsert, vkRagequit] = vkeys;
  const scripts = buildScripts({ seed: initSeed!, asset: { policy: '', name: '' }, vkSpend: vkSpend!, vkInsert: vkInsert!, vkRagequit: vkRagequit! }, { network });
  const run = async (tx: BuiltTx, seeds: Uint8Array[]): Promise<string> => {
    const id = await chain.submit(signTx(tx.cbor, seeds));
    chain.mineBlock();
    return id;
  };
  const payer = { address: enterpriseAddress(keys.operator, network) };
  // Publishing must leave the NFT policy's one-shot seed available for Init.
  const publish = await buildPublishScripts({ provider: chain, network }, {
    payer: { ...payer, utxos: (await chain.getUtxosAt(payer.address)).filter(u => u.ref.txId !== initSeed!.txId || u.ref.index !== initSeed!.index) },
    scripts, holder: payer.address,
  });
  for (const tx of publish.txs) await run(tx, [keys.operator]);
  const init = await buildInit({ provider: chain, network }, { payer, seed: initSeed!, scripts,
    config: {
      admins: keys.admin.map(key => Buffer.from(keyHash(key)).toString('hex')), adminThreshold: 1,
      treasury: { payment: { kind: 'key', hash: keyHash(keys.operator) }, stake: null }, depositsPaused: false,
      minDeposit: 5_000_000n, maxDeposit: 50_000_000n, poolCap: 500_000_000n, depositFeeBps: 0, settleFeeBps: 0, crankFee: 300_000n,
    },
    asp: { root: genesisPoolDatum().roots[0]!, operators: [Buffer.from(keyHash(keys.asp)).toString('hex')], threshold: 1, uri: '' },
  });
  await run(init, [keys.operator]);
  const ctx: ChainContext = { provider: chain, deployment: {
    network, poolId: scripts.poolId, seed: initSeed!, asset: { policy: '', name: '' }, scripts,
    vkeys: { spend: vkToHex(vkSpend!), insert: vkToHex(vkInsert!), ragequit: vkToHex(vkRagequit!) }, refScripts: publish.refScripts, initTx: init.txId,
  } };
  return { chain, ctx, keys, run };
}
