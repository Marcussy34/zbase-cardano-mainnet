import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { before, test } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { addressToBech32 } from '@zx402/crypto';
import { MeshTxBuilder } from '@meshsdk/core';
import {
  CborSet, Ed25519SignatureHex, Transaction, TxCBOR, VkeyWitness, serializeAddress,
} from '@meshsdk/core-cst';
import {
  enterpriseAddress, keyHash, publicKey, signTx, txId, verifyWitnesses, witnessKeyHashes,
} from '../src/keys.js';
import { MAINNET_PARAMETERS, minFee, slotToTime, timeToSlot } from '../src/types.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const decode = (cbor: string) => Transaction.fromCbor(TxCBOR(cbor));
let unsigned: string;

before(async () => {
  const address = serializeAddress({ pubKeyHash: '01'.repeat(28) }, 1);
  unsigned = await new MeshTxBuilder().setNetwork('mainnet')
    .txIn('10'.repeat(32), 0, [{ unit: 'lovelace', quantity: '20000000' }], address, 0)
    .txOut(address, [{ unit: 'lovelace', quantity: '2000000' }])
    .changeAddress(address).complete();
});

test('TX-05 foundation: raw seed keys match independent Noble and crypto address encoding', () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
  const expectedPublicKey = ed25519.getPublicKey(seed);
  const expectedHash = blake2b(expectedPublicKey, { dkLen: 28 });
  assert.deepEqual(publicKey(seed), expectedPublicKey);
  assert.deepEqual(keyHash(seed), expectedHash);
  assert.equal(enterpriseAddress(seed), addressToBech32({
    payment: { kind: 'key', hash: expectedHash }, stake: null,
  }));
  assert.match(enterpriseAddress(seed), /^addr1v/);
});

test('TX-05 foundation: signing preserves body bytes and adds a valid witness', () => {
  const seed = randomBytes(32);
  const signed = signTx(unsigned, [seed]);
  assert.equal(decode(signed).body().toCbor(), decode(unsigned).body().toCbor());
  assert.equal(txId(signed), txId(unsigned));
  assert.equal(decode(signed).witnessSet().vkeys()?.size(), 1);
  assert.deepEqual(witnessKeyHashes(signed), [hex(blake2b(ed25519.getPublicKey(seed), { dkLen: 28 }))]);
  assert.equal(verifyWitnesses(signed), true);
});

test('TX-05 foundation: signing preserves existing witnesses and avoids duplicate keys', () => {
  const first = randomBytes(32);
  const second = randomBytes(32);
  const once = signTx(unsigned, [first]);
  const twice = signTx(once, [second]);
  const repeated = signTx(twice, [first, second, first]);
  assert.equal(decode(repeated).witnessSet().vkeys()?.size(), 2);
  assert.deepEqual(decode(repeated).witnessSet().vkeys()?.toCore()[0], decode(once).witnessSet().vkeys()?.toCore()[0]);
  assert.deepEqual(witnessKeyHashes(repeated), [first, second].map(seed => hex(keyHash(seed))));
  assert.equal(verifyWitnesses(repeated), true);
});

test('TX-05 foundation: a one-byte signature change fails verification', () => {
  const tx = decode(signTx(unsigned, [randomBytes(32)]));
  const witnesses = tx.witnessSet();
  const entries = witnesses.vkeys()!.toCore();
  const signature = Buffer.from(entries[0]![1], 'hex');
  signature[0] = signature[0]! ^ 1;
  entries[0]![1] = Ed25519SignatureHex(signature.toString('hex'));
  witnesses.setVkeys(CborSet.fromCore(entries, VkeyWitness.fromCore));
  tx.setWitnessSet(witnesses);
  assert.equal(verifyWitnesses(tx.toCbor()), false);
});

test('TX-05 foundation: txId matches Mesh and hashes the original body bytes', () => {
  assert.equal(txId(unsigned), decode(unsigned).getId());
  assert.equal(txId(unsigned), hex(blake2b(Buffer.from(decode(unsigned).body().toCbor(), 'hex'), { dkLen: 32 })));
});

test('TX-05 foundation: signing retains a noncanonical body encoding', () => {
  const body = decode(unsigned).body().toCbor();
  // An indefinite map has the same meaning, but its bytes have a different hash.
  assert.match(body.slice(0, 2), /^a[0-9a-f]$/);
  const alternateBody = `bf${body.slice(2)}ff`;
  const alternateTx = unsigned.slice(0, 2) + alternateBody + unsigned.slice(2 + body.length);
  const signed = signTx(alternateTx, [randomBytes(32)]);
  assert.equal(decode(signed).body().toCbor(), alternateBody);
  assert.equal(txId(signed), hex(blake2b(Buffer.from(alternateBody, 'hex'), { dkLen: 32 })));
  assert.equal(verifyWitnesses(signed), true);
});

test('TX-05 foundation: raw seed helpers reject the wrong seed length', () => {
  for (const length of [0, 31, 33, 64]) {
    for (const derive of [publicKey, keyHash, enterpriseAddress]) {
      assert.throws(() => derive(new Uint8Array(length)), /32.byte/);
    }
    assert.throws(() => signTx(unsigned, [new Uint8Array(length)]), /32.byte/);
  }
});

test('TX-05 foundation: minFee matches the measured spike example', () => {
  assert.equal(minFee(MAINNET_PARAMETERS, {
    size: 1114, exUnits: [{ tag: 'spend', index: 1, mem: 259402n, steps: 100338596n }], refScriptBytes: 1464,
  }), 248559n);
});

test('TX-05 foundation: reference fees enter the second tier at 25600 bytes', () => {
  assert.equal(minFee(MAINNET_PARAMETERS, { size: 0, exUnits: [], refScriptBytes: 30000 }),
    155381n + 25600n * 15n + 4400n * 18n);
});

test('TX-05 foundation: execution fees sum before rounding and retain bigint precision', () => {
  const exUnits = [0, 1].map(index => ({ tag: 'spend' as const, index, mem: 1n, steps: 0n }));
  assert.equal(minFee(MAINNET_PARAMETERS, { size: 0, exUnits, refScriptBytes: 0 }), 155382n);
  const mem = 9007199254740993n;
  assert.equal(minFee(MAINNET_PARAMETERS, {
    size: 0, exUnits: [{ tag: 'spend', index: 0, mem, steps: 0n }], refScriptBytes: 0,
  }), 155381n + (mem * 577n + 9999n) / 10000n);
});

test('TX-05 foundation: slot and time conversions use the mainnet origin and floor', () => {
  assert.equal(slotToTime(4492800), 1596059091000);
  for (const slot of [0, 4492800, 200000000]) {
    assert.equal(timeToSlot(slotToTime(slot)), slot);
    assert.equal(timeToSlot(slotToTime(slot) + 999), slot);
  }
  assert.equal(timeToSlot(1596059090999), 4492799);
});

test('TX-05 foundation: preprod enterprise addresses retain the mainnet key hash', async () => {
  const { addressFromBech32 } = await import('@zx402/crypto');
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
  const mainnet = enterpriseAddress(seed);
  const preprod = enterpriseAddress(seed, 'preprod');
  assert.equal(enterpriseAddress(seed, 'mainnet'), mainnet);
  assert.match(preprod, /^addr_test1v/);
  assert.deepEqual(addressFromBech32(preprod, 'preprod'), addressFromBech32(mainnet));
  assert.deepEqual(addressFromBech32(preprod, 'preprod').payment, { kind: 'key', hash: keyHash(seed) });
});

test('TX-05 foundation: slot and time conversions use the preprod origin and floor', () => {
  assert.equal(slotToTime(86400, 'preprod'), 1655769600000);
  assert.equal(slotToTime(135602531, 'preprod'), 1791285731000);
  assert.equal(timeToSlot(1791285731000, 'preprod'), 135602531);
  for (const slot of [0, 86400, 135602531, 200000000]) {
    assert.equal(timeToSlot(slotToTime(slot, 'preprod'), 'preprod'), slot);
    assert.equal(timeToSlot(slotToTime(slot, 'preprod') + 999, 'preprod'), slot);
  }
  assert.equal(timeToSlot(1655769599999, 'preprod'), 86399);
});

test('TX-05 foundation: explicit mainnet slot conversion preserves the default', () => {
  for (const slot of [0, 4492800, 200000000]) {
    assert.equal(slotToTime(slot, 'mainnet'), slotToTime(slot));
    assert.equal(timeToSlot(slotToTime(slot), 'mainnet'), slot);
  }
});

test('TX-05 foundation: preprod parameters change only the transaction memory limit', async () => {
  const { PARAMETERS, PREPROD_PARAMETERS } = await import('../src/types.js');
  assert.deepEqual(PREPROD_PARAMETERS, { ...MAINNET_PARAMETERS, maxTxExMem: 17500000n });
  assert.equal(PARAMETERS.mainnet, MAINNET_PARAMETERS);
  assert.equal(PARAMETERS.preprod, PREPROD_PARAMETERS);
  assert.equal(MAINNET_PARAMETERS.maxTxExMem, 16500000n);
});
