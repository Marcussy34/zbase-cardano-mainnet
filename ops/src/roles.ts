import { hkdfSync } from 'node:crypto';
import { enterpriseAddress, keyHash, type Network } from '@zx402/txlib';

export type Role = 'operator' | 'holder' | 'admin' | 'asp' | 'crank' | 'relayer' | 'user' | 'agent' | 'seller';
export const ROLES: readonly Role[] = ['operator', 'holder', 'admin', 'asp', 'crank', 'relayer', 'user', 'agent', 'seller'];

/** An empty HKDF salt follows RFC 5869; the info text separates each role. */
export function roleSeed(operatorSeed: Uint8Array, role: Role): Uint8Array {
  if (operatorSeed.length !== 32) throw new Error('Expected a 32-byte operator seed');
  if (!ROLES.includes(role)) throw new Error('Unknown role');
  if (role === 'operator') return new Uint8Array(operatorSeed);
  return new Uint8Array(hkdfSync('sha256', operatorSeed, new Uint8Array(), `zx402/role/${role}/v1`, 32));
}
export function roleAddress(operatorSeed: Uint8Array, role: Role, network: Network): string {
  return enterpriseAddress(roleSeed(operatorSeed, role), network);
}
export function roleKeyHash(operatorSeed: Uint8Array, role: Role): string {
  return Buffer.from(keyHash(roleSeed(operatorSeed, role))).toString('hex');
}
