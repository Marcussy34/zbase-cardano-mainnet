import type { Value } from './types.js';

export interface AssetClass { policy: string; name: string }

/** True for an ADA pool: both fields empty. */
export function isAdaAsset(asset: AssetClass): boolean {
  return asset.policy === '' && asset.name === '';
}

/** The txlib value key uses lowercase hex so one asset has only one spelling. */
export function assetUnit(asset: AssetClass): string {
  if (isAdaAsset(asset)) return 'lovelace';
  // Asset names encode bytes, so an odd number of hex digits is not valid.
  if (!/^[0-9a-f]{56}$/.test(asset.policy) || !/^(?:[0-9a-f]{2}){0,32}$/.test(asset.name)) {
    throw new Error('Invalid asset class: expected a lowercase 56-hex policy and up to 32 name bytes');
  }
  return asset.policy + asset.name;
}

/** The API and x402 wire form separates the policy from the asset name. */
export function assetWireUnit(asset: AssetClass): string {
  return assetUnit(asset) === 'lovelace' ? 'lovelace' : `${asset.policy}.${asset.name}`;
}

/** Normalize wire hex so value lookups always use the canonical key. */
export function parseAssetWireUnit(unit: string): AssetClass {
  if (unit === 'lovelace') return { policy: '', name: '' };
  const match = /^([0-9a-fA-F]{56})\.((?:[0-9a-fA-F]{2}){0,32})$/.exec(unit);
  if (!match) throw new Error('Invalid asset wire unit: expected lovelace or policy.name');
  return { policy: match[1]!.toLowerCase(), name: match[2]!.toLowerCase() };
}

/** Read the pool asset without counting the ADA reserve of a token pool. */
export function assetAmount(value: Value, asset: AssetClass): bigint {
  const unit = assetUnit(asset);
  return unit === 'lovelace' ? value.lovelace : value.assets[unit] ?? 0n;
}

/** Return a fresh value so planning cannot change a caller's UTXO. */
export function addAssetAmount(value: Value, asset: AssetClass, delta: bigint): Value {
  const unit = assetUnit(asset);
  const amount = assetAmount(value, asset) + delta;
  if (amount < 0n) throw new RangeError('Asset amount cannot be negative');
  const next = { lovelace: value.lovelace, assets: { ...value.assets } };
  if (unit === 'lovelace') next.lovelace = amount;
  else if (amount === 0n) delete next.assets[unit];
  else next.assets[unit] = amount;
  return next;
}

/** Mesh amounts use decimal strings to preserve bigint precision. */
export function meshAsset(asset: AssetClass, quantity: bigint): { unit: string; quantity: string } {
  return { unit: assetUnit(asset), quantity: String(quantity) };
}
