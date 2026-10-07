import { parseAssetWireUnit, type AssetClass, type Network } from '@zbase-cardano/txlib';

export interface Settings { network: Network; blockfrostProjectId: string; operatorSeed: Uint8Array; asset: AssetClass }

/** Report variable names only, because environment values can contain credentials. */
export function readSettings(env: Record<string, string | undefined> = process.env): Settings {
  const network = env.NETWORK;
  if (network !== 'mainnet' && network !== 'preprod') throw new Error('Missing or malformed NETWORK');
  const blockfrostProjectId = env.BLOCKFROST_PROJECT_ID;
  if (!blockfrostProjectId || !new RegExp(`^${network}[a-zA-Z0-9]{32}$`).test(blockfrostProjectId)) {
    throw new Error('Missing or malformed BLOCKFROST_PROJECT_ID');
  }
  const seed = env.OPERATOR_SEED_HEX;
  if (!seed || !/^[a-fA-F0-9]{64}$/.test(seed)) throw new Error('Missing or malformed OPERATOR_SEED_HEX');
  let asset: AssetClass;
  try { asset = parseAssetWireUnit(env.POOL_ASSET ?? 'lovelace'); }
  catch { throw new Error('Malformed POOL_ASSET: expected lovelace or policy.name'); }
  return { network, blockfrostProjectId, operatorSeed: new Uint8Array(Buffer.from(seed, 'hex')), asset };
}
