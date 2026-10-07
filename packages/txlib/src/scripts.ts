import { readFileSync } from 'node:fs';
import * as Data from '@evolution-sdk/evolution/Data';
import { applyParamsToScript } from '@evolution-sdk/evolution/UPLC';
import { normalizePlutusScript, toScriptRef } from '@meshsdk/core-cst';
import { addressToBech32, type CardanoVk } from '@zx402/crypto';
import type { Network, UtxoRef } from './types.js';

export interface ScriptInfo {
  hash: string;
  /** Double CBOR wrapping, as Mesh builder and script-reference methods expect. */
  cbor: string;
  /** Ledger script bytes, including the inner CBOR byte-string prefix. */
  size: number;
  address: string;
}
export interface PoolScripts {
  nft: ScriptInfo; deposit: ScriptInfo; config: ScriptInfo; asp: ScriptInfo; pool: ScriptInfo; poolId: string;
}
export interface ScriptParams {
  seed: UtxoRef;
  asset: { policy: string; name: string };
  vkSpend: CardanoVk; vkInsert: CardanoVk; vkRagequit: CardanoVk;
}

const record = (...fields: Data.Data[]): Data.Data => Data.constr(0n, fields);
function hex(value: string): Data.Data {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('Expected hex script parameter');
  return Data.bytearray(value.toLowerCase());
}
const bytes = (value: Uint8Array): Data.Data => hex(Buffer.from(value).toString('hex'));
function verificationKey(vk: CardanoVk): Data.Data {
  return record(bytes(vk.alpha), bytes(vk.beta), bytes(vk.gamma), bytes(vk.delta), Data.list(vk.ic.map(bytes)));
}
function compiledCode(blueprint: unknown, title: string): string {
  const validators = blueprint && typeof blueprint === 'object' && 'validators' in blueprint ? blueprint.validators : undefined;
  if (!Array.isArray(validators)) throw new Error(`Missing validator ${title} in blueprint`);
  const validator: unknown = validators.find((value: unknown) =>
    value !== null && typeof value === 'object' && 'title' in value && value.title === title);
  if (!validator || typeof validator !== 'object') throw new Error(`Missing validator ${title} in blueprint`);
  if (!('compiledCode' in validator) || typeof validator.compiledCode !== 'string' || validator.compiledCode.length === 0) {
    throw new Error(`Missing compiled code for validator ${title}`);
  }
  return validator.compiledCode;
}

/** Loads the current blueprint relative to this module unless one is supplied. */
export function buildScripts(params: ScriptParams, options: { network?: Network; blueprint?: unknown } = {}): PoolScripts {
  const blueprint: unknown = options.blueprint ?? JSON.parse(readFileSync(new URL('../../../contracts/plutus.json', import.meta.url), 'utf8'));
  const network = options.network ?? 'mainnet';
  const code = {
    nft: compiledCode(blueprint, 'nft.nft.mint'),
    deposit: compiledCode(blueprint, 'deposit.deposit.spend'),
    config: compiledCode(blueprint, 'config.config.spend'),
    asp: compiledCode(blueprint, 'asp.asp.spend'),
    pool: compiledCode(blueprint, 'pool.pool.spend'),
  };
  if (!/^[0-9a-fA-F]{64}$/.test(params.seed.txId) || !Number.isSafeInteger(params.seed.index) || params.seed.index < 0) {
    throw new Error('Invalid seed output reference');
  }
  function apply(raw: string, parameters: Data.Data[], minting = false): ScriptInfo {
    // Do not use Mesh 1.9.1 applyParamsToScript here. It cuts every byte string over 64 bytes down to
    // 64 bytes, because its data writer and its CBOR library disagree. That corrupts the 96-byte G2
    // points of a verification key without any error. The Evolution SDK writes the same bytes as
    // `aiken blueprint apply`, and scripts.test.ts compares all five scripts against Aiken.
    const applied = applyParamsToScript(normalizePlutusScript(raw, 'DoubleCBOR'), parameters);
    const cbor = normalizePlutusScript(applied, 'DoubleCBOR');
    const script = toScriptRef({ code: cbor, version: 'V3' });
    const hash = script.hash();
    return {
      hash, cbor, size: script.asPlutusV3()!.rawBytes().length / 2,
      address: minting ? '' : addressToBech32({ payment: { kind: 'script', hash: Buffer.from(hash, 'hex') }, stake: null }, network),
    };
  }
  const nft = apply(code.nft, [record(hex(params.seed.txId), Data.int(BigInt(params.seed.index)))], true);
  const policy = hex(nft.hash);
  const deposit = apply(code.deposit, [policy]);
  const config = apply(code.config, [policy]);
  const asp = apply(code.asp, [policy]);
  const pool = apply(code.pool, [
    policy, hex(deposit.hash), record(hex(params.asset.policy), hex(params.asset.name)),
    verificationKey(params.vkSpend), verificationKey(params.vkInsert), verificationKey(params.vkRagequit),
  ]);
  return { nft, deposit, config, asp, pool, poolId: nft.hash };
}
