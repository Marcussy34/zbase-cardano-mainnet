import assert from 'node:assert/strict';
import test from 'node:test';
import { Trie } from '@aiken-lang/merkle-patricia-forestry';
import { deserializePlutusData, fromJsonToPlutusData, type PlutusData } from '@meshsdk/core-cst';
import type { CardanoProof, PayoutAddress, SettleIntent } from '@zx402/crypto';
import {
  decodeAspDatum, decodeConfigDatum, decodeDepositDatum, decodePoolDatum, decodePoolRedeemer,
  encodeAspDatum, encodeConfigDatum, encodeDepositDatum, encodeDepositRedeemer, encodePoolDatum,
  encodePoolRedeemer, encodeVoid,
  type AspDatum, type ConfigDatum, type DepositDatum, type PoolDatum, type PoolRedeemer,
} from '../src/codec.js';

const bytes = (length: number, value: number): Uint8Array => new Uint8Array(length).fill(value);
const keyAddress: PayoutAddress = { payment: { kind: 'key', hash: bytes(28, 1) }, stake: null };
const baseAddress: PayoutAddress = {
  payment: { kind: 'script', hash: bytes(28, 2) }, stake: { kind: 'key', hash: bytes(28, 3) },
};
const proof: CardanoProof = { a: bytes(48, 4), b: bytes(96, 5), c: bytes(48, 6) };
const pool: PoolDatum = {
  roots: Array.from({ length: 16 }, (_, i) => 2n ** 200n + BigInt(i)), size: 256,
  queue: Array.from({ length: 8 }, (_, i) => 2n ** 220n + BigInt(i)),
  nullifierRoot: 'ab'.repeat(32), feesAccrued: 123456789n,
};
const deposit: DepositDatum = { precommitment: 2n ** 250n, refund: '12'.repeat(28) };
const config: ConfigDatum = {
  admins: ['12'.repeat(28), '34'.repeat(28)], adminThreshold: 2, treasury: baseAddress,
  depositsPaused: false, minDeposit: 5000000n, maxDeposit: 50000000n, poolCap: 500000000n,
  depositFeeBps: 0, settleFeeBps: 0, crankFee: 300000n,
};
const asp: AspDatum = { root: 2n ** 200n, operators: ['56'.repeat(28)], threshold: 1, uri: 'https://asp.example/树' };
const intent: SettleIntent = {
  poolId: bytes(28, 7),
  payouts: [
    { address: keyAddress, amount: 5000000n, datumHash: null },
    { address: baseAddress, amount: 6000000n, datumHash: bytes(32, 8) },
    { address: { ...keyAddress, stake: { kind: 'script', hash: bytes(28, 9) } }, amount: 7000000n, datumHash: null },
    { address: { ...baseAddress, stake: null }, amount: 8000000n, datumHash: null },
  ],
  relayer: bytes(28, 10), validUntil: 1791288000000n,
};
const settle: PoolRedeemer = {
  kind: 'Settle', proof, nullifierHash: 123n, newCommitment: 456n, withdrawn: 26000000n,
  stateRoot: pool.roots[0]!, intent, nullifierProof: '9fff',
};

function fields(data: PlutusData, index: number, count: number): PlutusData[] {
  const constructor = data.asConstrPlutusData();
  assert.ok(constructor);
  assert.equal(constructor.getAlternative(), BigInt(index));
  const list = constructor.getData();
  assert.equal(list.getLength(), count);
  return Array.from({ length: count }, (_, i) => list.get(i));
}

test('TX-01: PoolDatum preserves the full root history and queue', () => {
  assert.deepEqual(decodePoolDatum(encodePoolDatum(pool)), pool);
});

test('TX-02: DepositDatum round-trips', () => {
  assert.deepEqual(decodeDepositDatum(encodeDepositDatum(deposit)), deposit);
});

test('TX-07: ConfigDatum and AspDatum round-trip', () => {
  for (const depositsPaused of [false, true]) {
    const datum = { ...config, depositsPaused };
    assert.deepEqual(decodeConfigDatum(encodeConfigDatum(datum)), datum);
  }
  assert.deepEqual(decodeAspDatum(encodeAspDatum(asp)), asp);
});

test('TX-04: Insert round-trips', () => {
  const redeemer: PoolRedeemer = { kind: 'Insert', proof, flush: 4 };
  assert.deepEqual(decodePoolRedeemer(encodePoolRedeemer(redeemer)), redeemer);
});

test('TX-05: Settle preserves four payouts, credentials, datum hash, and relayer', () => {
  assert.deepEqual(decodePoolRedeemer(encodePoolRedeemer(settle)), settle);
  const withoutRelayer = { ...settle, intent: { ...intent, relayer: null } };
  assert.deepEqual(decodePoolRedeemer(encodePoolRedeemer(withoutRelayer)), withoutRelayer);
});

test('TX-06: Ragequit preserves the output reference and refund key', () => {
  const redeemer: PoolRedeemer = {
    kind: 'Ragequit', proof, nullifierHash: 123n, value: 5000000n, stateRoot: 456n,
    depositRef: { txId: 'cd'.repeat(32), index: 2 }, refund: deposit.refund, nullifierProof: '9fff',
  };
  const cbor = encodePoolRedeemer(redeemer);
  assert.deepEqual(decodePoolRedeemer(cbor), redeemer);
  const reference = fields(fields(deserializePlutusData(cbor), 2, 7)[4]!, 0, 2);
  assert.equal(Buffer.from(reference[0]!.asBoundedBytes()!).toString('hex'), redeemer.depositRef.txId);
  assert.equal(reference[1]!.asInteger(), 2n);
});

test('TX-07: CollectFees, deposit variants, and ignored unit have Aiken constructors', () => {
  const redeemer: PoolRedeemer = { kind: 'CollectFees', amount: 1200000n };
  assert.deepEqual(decodePoolRedeemer(encodePoolRedeemer(redeemer)), redeemer);
  fields(deserializePlutusData(encodePoolRedeemer(redeemer)), 3, 1);
  for (const [kind, index] of [['Absorb', 0], ['Refund', 1]] as const) {
    const data = deserializePlutusData(encodeDepositRedeemer(kind));
    fields(data, index, 0);
    assert.equal(['Absorb', 'Refund'][Number(data.asConstrPlutusData()!.getAlternative())], kind);
  }
  assert.equal(encodeVoid(), 'd87980');
});

test('TX-01: small PoolDatum has the specified constructor and field order', () => {
  const small: PoolDatum = { roots: [1n], size: 2, queue: [3n], nullifierRoot: '00'.repeat(32), feesAccrued: 4n };
  const data = deserializePlutusData(encodePoolDatum(small));
  const values = fields(data, 0, 5);
  assert.equal(values[0]!.asList()!.get(0).asInteger(), 1n);
  assert.equal(values[1]!.asInteger(), 2n);
  assert.equal(values[2]!.asList()!.get(0).asInteger(), 3n);
  assert.deepEqual(values[3]!.asBoundedBytes(), bytes(32, 0));
  assert.equal(values[4]!.asInteger(), 4n);
});

test('TX-05: Settle options and addresses match the Aiken nesting', () => {
  const values = fields(deserializePlutusData(encodePoolRedeemer(settle)), 1, 7);
  fields(values[0]!, 0, 3);
  assert.deepEqual(values.slice(1, 5).map(value => value.asInteger()), [123n, 456n, 26000000n, pool.roots[0]]);
  const intentFields = fields(values[5]!, 0, 4);
  const payouts = intentFields[1]!.asList()!;
  assert.equal(payouts.getLength(), 4);
  const first = fields(payouts.get(0), 0, 3);
  const firstAddress = fields(first[0]!, 0, 2);
  fields(firstAddress[0]!, 0, 1);
  fields(firstAddress[1]!, 1, 0);
  fields(first[2]!, 1, 0);
  const second = fields(payouts.get(1), 0, 3);
  const secondAddress = fields(second[0]!, 0, 2);
  fields(secondAddress[0]!, 1, 1);
  const stake = fields(fields(secondAddress[1]!, 0, 1)[0]!, 0, 1);
  fields(stake[0]!, 0, 1);
  fields(second[2]!, 0, 1);
  fields(intentFields[2]!, 0, 1);
  assert.equal(intentFields[3]!.asInteger(), intent.validUntil);
  assert.ok(values[6]!.asList());
  for (const depositsPaused of [false, true]) {
    const configFields = fields(deserializePlutusData(encodeConfigDatum({ ...config, depositsPaused })), 0, 10);
    fields(configFields[3]!, depositsPaused ? 1 : 0, 0);
  }
});

test('TX-05: trie proof CBOR is embedded as data without a byte-string wrapper', async () => {
  const trie = await Trie.fromList(Array.from({ length: 32 }, (_, i) => ({ key: `key-${i}`, value: `value-${i}` })));
  const nullifierProof = (await trie.prove('key-0')).toCBOR().toString('hex');
  const redeemer = { ...settle, nullifierProof };
  const cbor = encodePoolRedeemer(redeemer);
  const embedded = fields(deserializePlutusData(cbor), 1, 7)[6]!;
  assert.ok(embedded.asList()!.getLength() > 0);
  assert.equal(embedded.toCbor(), nullifierProof);
  assert.deepEqual(decodePoolRedeemer(cbor), redeemer);
});

test('TX-01: datum decoders reject another datum type and name the expected type', () => {
  assert.throws(() => decodePoolDatum(encodeDepositDatum(deposit)), /PoolDatum/);
  assert.throws(() => decodeDepositDatum(encodePoolDatum(pool)), /DepositDatum/);
  assert.throws(() => decodeConfigDatum(encodeAspDatum(asp)), /ConfigDatum/);
  assert.throws(() => decodeAspDatum(encodeConfigDatum(config)), /AspDatum/);
  assert.throws(() => decodePoolRedeemer(encodePoolDatum(pool)), /PoolRedeemer/);
});

test('TX-01: malformed CBOR, fields, and unsafe integers report the expected type', () => {
  assert.throws(() => decodePoolDatum('zz'), /PoolDatum/);
  const json = (size: bigint, root: string) => fromJsonToPlutusData({ constructor: 0, fields: [
    { list: [{ int: 1 }] }, { int: size }, { list: [] }, { bytes: root }, { int: 0 },
  ] }).toCbor();
  assert.throws(() => decodePoolDatum(json(2n ** 53n, pool.nullifierRoot)), /PoolDatum/);
  assert.throws(() => decodePoolDatum(json(1n, 'ab')), /PoolDatum/);
  assert.throws(() => decodePoolRedeemer(fromJsonToPlutusData({ constructor: 4, fields: [] }).toCbor()), /PoolRedeemer/);
});
