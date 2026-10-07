import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { assertCanonical, bigIntToBytesBE, bytesToBigIntBE } from "./field.js";
import { NETWORKS, type Network } from "./network.js";

export const MAX_PAYOUTS = 4;

export interface Credential {
  kind: "key" | "script";
  hash: Uint8Array;
}

export interface PayoutAddress {
  payment: Credential;
  stake: Credential | null;
}

export interface Payout {
  address: PayoutAddress;
  amount: bigint;
  datumHash: Uint8Array | null;
}

export interface SettleIntent {
  poolId: Uint8Array;
  payouts: Payout[];
  relayer: Uint8Array | null;
  validUntil: bigint;
}

// These domains bind hashes to the protocol, so a rename requires a new pool.
const LABEL_TAG = utf8ToBytes("zx402/label/v1");
const INTENT_TAG = utf8ToBytes("zx402/intent/v1");

function fixedBytes(bytes: Uint8Array, length: number, field: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new RangeError(`${field} must be exactly ${length} bytes`);
  }
  return bytes;
}

function u64(value: bigint, field: string): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value >= 2n ** 64n) {
    throw new RangeError(`${field} must satisfy 0 <= x < 2^64`);
  }
  return bigIntToBytesBE(value, 8);
}

function credentialKind(credential: Credential, field: string): number {
  if (credential.kind !== "key" && credential.kind !== "script") {
    throw new RangeError(`${field}.kind must be key or script`);
  }
  fixedBytes(credential.hash, 28, `${field}.hash`);
  return credential.kind === "key" ? 0 : 1;
}

function credentialBytes(credential: Credential, field: string): Uint8Array {
  return concatBytes(Uint8Array.of(credentialKind(credential, field)), credential.hash);
}

function optionalBytes(bytes: Uint8Array | null, length: number, field: string): Uint8Array {
  return bytes === null
    ? Uint8Array.of(0)
    : concatBytes(Uint8Array.of(1), fixedBytes(bytes, length, field));
}

function hashToField(bytes: Uint8Array): bigint {
  // The digest length is part of BLAKE2b, so do not truncate a 64-byte digest.
  return bytesToBigIntBE(blake2b(bytes, { dkLen: 32 }).subarray(0, 31));
}

export function labelFor(a: {
  poolId: Uint8Array;
  txId: Uint8Array;
  outputIndex: number;
  refundKeyHash: Uint8Array;
}): bigint {
  return hashToField(labelPreimage(a));
}

export function labelPreimage(a: Parameters<typeof labelFor>[0]): Uint8Array {
  if (!Number.isInteger(a.outputIndex) || a.outputIndex < 0 || a.outputIndex >= 2 ** 32) {
    throw new RangeError("outputIndex must be an integer satisfying 0 <= x < 2^32");
  }
  return concatBytes(
    LABEL_TAG,
    fixedBytes(a.poolId, 28, "poolId"),
    fixedBytes(a.txId, 32, "txId"),
    bigIntToBytesBE(BigInt(a.outputIndex), 4),
    fixedBytes(a.refundKeyHash, 28, "refundKeyHash"),
  );
}

export function intentBytes(intent: SettleIntent): Uint8Array {
  if (intent.payouts.length < 1 || intent.payouts.length > MAX_PAYOUTS) {
    throw new RangeError(`payouts must contain 1 to ${MAX_PAYOUTS} entries`);
  }
  const payouts = intent.payouts.map((payout, index) => {
    const field = `payouts[${index}]`;
    return concatBytes(
      credentialBytes(payout.address.payment, `${field}.address.payment`),
      payout.address.stake === null
        ? Uint8Array.of(0)
        : concatBytes(Uint8Array.of(1), credentialBytes(payout.address.stake, `${field}.address.stake`)),
      u64(payout.amount, `${field}.amount`),
      optionalBytes(payout.datumHash, 32, `${field}.datumHash`),
    );
  });
  return concatBytes(
    INTENT_TAG,
    fixedBytes(intent.poolId, 28, "poolId"),
    Uint8Array.of(payouts.length),
    ...payouts,
    optionalBytes(intent.relayer, 28, "relayer"),
    u64(intent.validUntil, "validUntil"),
  );
}

export function contextFor(intent: SettleIntent): bigint {
  return hashToField(intentBytes(intent));
}

export function nullifierKey(nullifierHash: bigint): Uint8Array {
  return bigIntToBytesBE(assertCanonical(nullifierHash, "nullifierHash"), 32);
}

/** Shelley addresses on the selected network only. Rejects pointer, Byron, and reward addresses. */
export function addressFromBech32(address: string, network: Network = "mainnet"): PayoutAddress {
  let decoded: ReturnType<typeof bech32.decodeToBytes>;
  try {
    decoded = bech32.decodeToBytes(address);
  } catch {
    throw new RangeError("address must have valid Bech32 encoding and checksum");
  }
  const { prefix, bytes } = decoded;
  const header = bytes[0];
  const { id, addressPrefix } = NETWORKS[network];
  if (prefix !== addressPrefix || header === undefined || (header & 0x0f) !== id) {
    throw new RangeError(`address must use the ${addressPrefix} prefix and ${network} network tag ${id}`);
  }
  const type = header >> 4;
  if (type > 3 && type !== 6 && type !== 7) {
    throw new RangeError("address must be a base or enterprise Shelley address");
  }
  fixedBytes(bytes, type <= 3 ? 57 : 29, "address payload");
  return {
    payment: { kind: (type & 1) === 0 ? "key" : "script", hash: bytes.slice(1, 29) },
    stake: type <= 3
      ? { kind: (type & 2) === 0 ? "key" : "script", hash: bytes.slice(29, 57) }
      : null,
  };
}

export function addressToBech32(address: PayoutAddress, network: Network = "mainnet"): string {
  const { id, addressPrefix } = NETWORKS[network];
  const payment = credentialKind(address.payment, "address.payment");
  const type = address.stake === null
    ? 6 + payment
    : payment + 2 * credentialKind(address.stake, "address.stake");
  const bytes = concatBytes(
    Uint8Array.of((type << 4) | id),
    address.payment.hash,
    address.stake?.hash ?? new Uint8Array(),
  );
  // Cardano base addresses exceed Bech32's default 90-character limit.
  return bech32.encode(addressPrefix, bech32.toWords(bytes), false);
}
