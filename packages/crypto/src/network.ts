export type Network = "mainnet" | "preprod";

export interface NetworkInfo {
  id: 0 | 1;
  addressPrefix: "addr" | "addr_test";
  zeroTime: number;
  zeroSlot: number;
  slotLength: number;
  x402: "cardano:mainnet" | "cardano:preprod";
}

export const NETWORKS: Readonly<Record<Network, NetworkInfo>> = {
  mainnet: {
    id: 1, addressPrefix: "addr", zeroTime: 1596059091000, zeroSlot: 4492800,
    slotLength: 1000, x402: "cardano:mainnet",
  },
  preprod: {
    id: 0, addressPrefix: "addr_test", zeroTime: 1655769600000, zeroSlot: 86400,
    slotLength: 1000, x402: "cardano:preprod",
  },
};
