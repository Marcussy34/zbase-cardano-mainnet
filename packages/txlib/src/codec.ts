import { ConstrPlutusData, deserializePlutusData, PlutusData, PlutusList } from '@meshsdk/core-cst';
import type { CardanoProof, PayoutAddress, SettleIntent } from '@zx402/crypto';
import type { UtxoRef } from './types.js';

export interface PoolDatum {
  roots: bigint[]; size: number; queue: bigint[]; nullifierRoot: string; feesAccrued: bigint;
}
export interface DepositDatum { precommitment: bigint; refund: string }
export interface ConfigDatum {
  admins: string[]; adminThreshold: number; treasury: PayoutAddress; depositsPaused: boolean;
  minDeposit: bigint; maxDeposit: bigint; poolCap: bigint; depositFeeBps: number; settleFeeBps: number; crankFee: bigint;
}
export interface AspDatum { root: bigint; operators: string[]; threshold: number; uri: string }
export type PoolRedeemer =
  | { kind: 'Insert'; proof: CardanoProof; flush: number }
  | { kind: 'Settle'; proof: CardanoProof; nullifierHash: bigint; newCommitment: bigint; withdrawn: bigint;
      stateRoot: bigint; intent: SettleIntent; nullifierProof: string }
  | { kind: 'Ragequit'; proof: CardanoProof; nullifierHash: bigint; value: bigint; stateRoot: bigint;
      depositRef: UtxoRef; refund: string; nullifierProof: string }
  | { kind: 'CollectFees'; amount: bigint };
export type DepositRedeemer = 'Absorb' | 'Refund';

function list(values: PlutusData[]): PlutusList {
  const result = new PlutusList();
  for (const value of values) result.add(value);
  return result;
}
const array = (values: PlutusData[]): PlutusData => PlutusData.newList(list(values));
const constr = (index: number, values: PlutusData[] = []): PlutusData =>
  PlutusData.newConstrPlutusData(new ConstrPlutusData(BigInt(index), list(values)));
const integer = (value: bigint): PlutusData => PlutusData.newInteger(value);
function number(value: number): PlutusData {
  if (!Number.isSafeInteger(value)) throw new Error('Expected a safe integer');
  return integer(BigInt(value));
}
function bytes(value: Uint8Array, length?: number): PlutusData {
  if (length !== undefined && value.length !== length) throw new Error(`Expected ${length} bytes`);
  return PlutusData.newBytes(value);
}
function hex(value: string, length?: number): PlutusData {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('Expected hex bytes');
  return bytes(Buffer.from(value, 'hex'), length);
}
const option = (value: PlutusData | null): PlutusData => value === null ? constr(1) : constr(0, [value]);

function readList(value: PlutusData): PlutusData[] {
  const values = value.asList();
  if (!values) throw new Error('Expected a list');
  return Array.from({ length: values.getLength() }, (_, i) => values.get(i));
}
function readFields(value: PlutusData, index: number, count: number): PlutusData[] {
  const constructor = value.asConstrPlutusData();
  if (!constructor || constructor.getAlternative() !== BigInt(index) || constructor.getData().getLength() !== count) {
    throw new Error(`Expected constructor ${index} with ${count} fields`);
  }
  return Array.from({ length: count }, (_, i) => constructor.getData().get(i));
}
function readInteger(value: PlutusData): bigint {
  const result = value.asInteger();
  if (result === undefined) throw new Error('Expected an integer');
  return result;
}
function readNumber(value: PlutusData): number {
  const result = Number(readInteger(value));
  if (!Number.isSafeInteger(result)) throw new Error('Expected a safe integer');
  return result;
}
function readBytes(value: PlutusData, length?: number): Uint8Array {
  const result = value.asBoundedBytes();
  if (!result || (length !== undefined && result.length !== length)) throw new Error(`Expected ${length ?? ''} bytes`);
  return new Uint8Array(result);
}
const readHex = (value: PlutusData, length?: number): string => Buffer.from(readBytes(value, length)).toString('hex');
function readOption<T>(value: PlutusData, read: (field: PlutusData) => T): T | null {
  if (value.asConstrPlutusData()?.getAlternative() === 1n) {
    readFields(value, 1, 0);
    return null;
  }
  return read(readFields(value, 0, 1)[0]!);
}
function parse(cbor: string): PlutusData {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(cbor)) throw new Error('Expected CBOR hex');
  return deserializePlutusData(cbor);
}
function decode<T>(name: string, cbor: string, read: (data: PlutusData) => T): T {
  try {
    return read(parse(cbor));
  } catch (cause) {
    throw new Error(`Invalid ${name}: ${cause instanceof Error ? cause.message : 'wrong data shape'}`, { cause });
  }
}

function credential(value: PayoutAddress['payment']): PlutusData {
  return constr(value.kind === 'key' ? 0 : 1, [bytes(value.hash, 28)]);
}
function readCredential(value: PlutusData): PayoutAddress['payment'] {
  const index = value.asConstrPlutusData()?.getAlternative() === 0n ? 0 : 1;
  return { kind: index === 0 ? 'key' : 'script', hash: readBytes(readFields(value, index, 1)[0]!, 28) };
}
function address(value: PayoutAddress): PlutusData {
  // Stake credentials have both the Some wrapper and the Referenced.Inline wrapper.
  return constr(0, [credential(value.payment), option(value.stake === null ? null : constr(0, [credential(value.stake)]))]);
}
function readAddress(value: PlutusData): PayoutAddress {
  const fields = readFields(value, 0, 2);
  return {
    payment: readCredential(fields[0]!),
    stake: readOption(fields[1]!, field => readCredential(readFields(field, 0, 1)[0]!)),
  };
}
function proof(value: CardanoProof): PlutusData {
  return constr(0, [bytes(value.a, 48), bytes(value.b, 96), bytes(value.c, 48)]);
}
function readProof(value: PlutusData): CardanoProof {
  const fields = readFields(value, 0, 3);
  return { a: readBytes(fields[0]!, 48), b: readBytes(fields[1]!, 96), c: readBytes(fields[2]!, 48) };
}
function intent(value: SettleIntent): PlutusData {
  return constr(0, [
    bytes(value.poolId, 28),
    array(value.payouts.map(payout => constr(0, [
      address(payout.address), integer(payout.amount), option(payout.datumHash === null ? null : bytes(payout.datumHash, 32)),
    ]))),
    option(value.relayer === null ? null : bytes(value.relayer, 28)), integer(value.validUntil),
  ]);
}
function readIntent(value: PlutusData): SettleIntent {
  const fields = readFields(value, 0, 4);
  return {
    poolId: readBytes(fields[0]!, 28),
    payouts: readList(fields[1]!).map(payout => {
      const fields = readFields(payout, 0, 3);
      return {
        address: readAddress(fields[0]!), amount: readInteger(fields[1]!),
        datumHash: readOption(fields[2]!, field => readBytes(field, 32)),
      };
    }),
    relayer: readOption(fields[2]!, field => readBytes(field, 28)), validUntil: readInteger(fields[3]!),
  };
}
function outputReference(value: UtxoRef): PlutusData {
  return constr(0, [hex(value.txId, 32), number(value.index)]);
}
function readOutputReference(value: PlutusData): UtxoRef {
  const fields = readFields(value, 0, 2);
  return { txId: readHex(fields[0]!, 32), index: readNumber(fields[1]!) };
}
function readTrieProof(value: PlutusData): string {
  // mpf.Proof is List<ProofStep>: Branch(0), Fork(1), Leaf(2). Neighbor is a record(0).
  for (const step of readList(value)) {
    const index = step.asConstrPlutusData()?.getAlternative();
    if (index === 0n) {
      const fields = readFields(step, 0, 2);
      readInteger(fields[0]!);
      readBytes(fields[1]!);
    } else if (index === 1n) {
      const fields = readFields(step, 1, 2);
      readInteger(fields[0]!);
      const neighbor = readFields(fields[1]!, 0, 3);
      readInteger(neighbor[0]!);
      readBytes(neighbor[1]!);
      readBytes(neighbor[2]!);
    } else {
      const fields = readFields(step, 2, 3);
      readInteger(fields[0]!);
      readBytes(fields[1]!);
      readBytes(fields[2]!);
    }
  }
  return value.toCbor();
}
function trieProof(cbor: string): PlutusData {
  const value = parse(cbor);
  readTrieProof(value);
  // The library retains original CBOR, including indefinite lists and chunked bytes.
  return value;
}

export function encodePoolDatum(d: PoolDatum): string {
  return constr(0, [array(d.roots.map(integer)), number(d.size), array(d.queue.map(integer)),
    hex(d.nullifierRoot, 32), integer(d.feesAccrued)]).toCbor();
}
export function decodePoolDatum(cbor: string): PoolDatum {
  return decode('PoolDatum', cbor, data => {
    const fields = readFields(data, 0, 5);
    return {
      roots: readList(fields[0]!).map(readInteger), size: readNumber(fields[1]!),
      queue: readList(fields[2]!).map(readInteger), nullifierRoot: readHex(fields[3]!, 32), feesAccrued: readInteger(fields[4]!),
    };
  });
}
export function encodeDepositDatum(d: DepositDatum): string {
  return constr(0, [integer(d.precommitment), hex(d.refund, 28)]).toCbor();
}
export function decodeDepositDatum(cbor: string): DepositDatum {
  return decode('DepositDatum', cbor, data => {
    const fields = readFields(data, 0, 2);
    return { precommitment: readInteger(fields[0]!), refund: readHex(fields[1]!, 28) };
  });
}
export function encodeConfigDatum(d: ConfigDatum): string {
  return constr(0, [
    array(d.admins.map(admin => hex(admin, 28))), number(d.adminThreshold), address(d.treasury), constr(d.depositsPaused ? 1 : 0),
    integer(d.minDeposit), integer(d.maxDeposit), integer(d.poolCap), number(d.depositFeeBps), number(d.settleFeeBps), integer(d.crankFee),
  ]).toCbor();
}
export function decodeConfigDatum(cbor: string): ConfigDatum {
  return decode('ConfigDatum', cbor, data => {
    const fields = readFields(data, 0, 10);
    const depositsPaused = fields[3]!.asConstrPlutusData()?.getAlternative() === 1n;
    readFields(fields[3]!, depositsPaused ? 1 : 0, 0);
    return {
      admins: readList(fields[0]!).map(admin => readHex(admin, 28)), adminThreshold: readNumber(fields[1]!),
      treasury: readAddress(fields[2]!), depositsPaused, minDeposit: readInteger(fields[4]!), maxDeposit: readInteger(fields[5]!),
      poolCap: readInteger(fields[6]!), depositFeeBps: readNumber(fields[7]!), settleFeeBps: readNumber(fields[8]!), crankFee: readInteger(fields[9]!),
    };
  });
}
export function encodeAspDatum(d: AspDatum): string {
  return constr(0, [integer(d.root), array(d.operators.map(operator => hex(operator, 28))), number(d.threshold),
    bytes(new TextEncoder().encode(d.uri))]).toCbor();
}
export function decodeAspDatum(cbor: string): AspDatum {
  return decode('AspDatum', cbor, data => {
    const fields = readFields(data, 0, 4);
    return {
      root: readInteger(fields[0]!), operators: readList(fields[1]!).map(operator => readHex(operator, 28)),
      threshold: readNumber(fields[2]!), uri: new TextDecoder('utf-8', { fatal: true }).decode(readBytes(fields[3]!)),
    };
  });
}

export function encodePoolRedeemer(r: PoolRedeemer): string {
  switch (r.kind) {
    case 'Insert': return constr(0, [proof(r.proof), number(r.flush)]).toCbor();
    case 'Settle': return constr(1, [
      proof(r.proof), integer(r.nullifierHash), integer(r.newCommitment), integer(r.withdrawn), integer(r.stateRoot),
      intent(r.intent), trieProof(r.nullifierProof),
    ]).toCbor();
    case 'Ragequit': return constr(2, [
      proof(r.proof), integer(r.nullifierHash), integer(r.value), integer(r.stateRoot),
      outputReference(r.depositRef), hex(r.refund, 28), trieProof(r.nullifierProof),
    ]).toCbor();
    case 'CollectFees': return constr(3, [integer(r.amount)]).toCbor();
  }
}
export function decodePoolRedeemer(cbor: string): PoolRedeemer {
  return decode('PoolRedeemer', cbor, data => {
    switch (data.asConstrPlutusData()?.getAlternative()) {
      case 0n: {
        const fields = readFields(data, 0, 2);
        return { kind: 'Insert', proof: readProof(fields[0]!), flush: readNumber(fields[1]!) };
      }
      case 1n: {
        const fields = readFields(data, 1, 7);
        return {
          kind: 'Settle', proof: readProof(fields[0]!), nullifierHash: readInteger(fields[1]!), newCommitment: readInteger(fields[2]!),
          withdrawn: readInteger(fields[3]!), stateRoot: readInteger(fields[4]!), intent: readIntent(fields[5]!), nullifierProof: readTrieProof(fields[6]!),
        };
      }
      case 2n: {
        const fields = readFields(data, 2, 7);
        return {
          kind: 'Ragequit', proof: readProof(fields[0]!), nullifierHash: readInteger(fields[1]!), value: readInteger(fields[2]!),
          stateRoot: readInteger(fields[3]!), depositRef: readOutputReference(fields[4]!), refund: readHex(fields[5]!, 28), nullifierProof: readTrieProof(fields[6]!),
        };
      }
      case 3n: return { kind: 'CollectFees', amount: readInteger(readFields(data, 3, 1)[0]!) };
      default: throw new Error('Unknown constructor');
    }
  });
}
export function encodeDepositRedeemer(r: DepositRedeemer): string {
  return constr(r === 'Absorb' ? 0 : 1).toCbor();
}
/** The unit redeemer that the config and ASP validators ignore. */
export function encodeVoid(): string {
  return constr(0).toCbor();
}
