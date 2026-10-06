import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { addressToBech32, type Network } from '@zbase-cardano/crypto';
import {
  CborSet, Ed25519PublicKeyHex, Ed25519SignatureHex, Transaction, TxCBOR, VkeyWitness,
} from '@meshsdk/core-cst';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const decode = (cbor: string): Transaction => Transaction.fromCbor(TxCBOR(cbor));

/** Derives a public key from a raw 32-byte Ed25519 seed. */
export function publicKey(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new RangeError('Expected a raw 32-byte Ed25519 seed');
  return ed25519.getPublicKey(seed);
}

export function keyHash(seed: Uint8Array): Uint8Array {
  return blake2b(publicKey(seed), { dkLen: 28 });
}

export function enterpriseAddress(seed: Uint8Array, network: Network = 'mainnet'): string {
  return addressToBech32({ payment: { kind: 'key', hash: keyHash(seed) }, stake: null }, network);
}

/** Hashes the body bytes as encoded, including noncanonical encodings. */
export function txId(txCbor: string): string {
  return decode(txCbor).getId();
}

/** Adds missing key witnesses without changing the body or existing witnesses. */
export function signTx(txCbor: string, seeds: Uint8Array[]): string {
  const tx = decode(txCbor);
  const body = tx.body().toCbor();
  const hash = Buffer.from(tx.getId(), 'hex');
  const witnesses = tx.witnessSet();
  const entries = witnesses.vkeys()?.toCore() ?? [];
  const present = new Set(entries.map(([key]) => key));
  for (const seed of seeds) {
    const key = Ed25519PublicKeyHex(hex(publicKey(seed)));
    if (present.has(key)) continue;
    entries.push([key, Ed25519SignatureHex(hex(ed25519.sign(hash, seed)))]);
    present.add(key);
  }
  witnesses.setVkeys(CborSet.fromCore(entries, VkeyWitness.fromCore));
  // Mutate only the witness set. Rebuilding the body can invalidate earlier signatures.
  tx.setWitnessSet(witnesses);
  const signed = tx.toCbor();
  if (decode(signed).body().toCbor() !== body) throw new Error('Signing changed the transaction body bytes');
  return signed;
}

/** Checks all present key witnesses, without asserting that required witnesses exist. */
export function verifyWitnesses(txCbor: string): boolean {
  const tx = decode(txCbor);
  const hash = Buffer.from(tx.getId(), 'hex');
  return (tx.witnessSet().vkeys()?.toCore() ?? []).every(([key, signature]) =>
    ed25519.verify(Buffer.from(signature, 'hex'), hash, Buffer.from(key, 'hex'), { zip215: false }));
}

export function witnessKeyHashes(txCbor: string): string[] {
  return (decode(txCbor).witnessSet().vkeys()?.toCore() ?? [])
    .map(([key]) => hex(blake2b(Buffer.from(key, 'hex'), { dkLen: 28 })));
}
