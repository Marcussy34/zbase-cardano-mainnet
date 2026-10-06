export interface TxRecord { txId: string; blockHeight: number; indexInBlock: number }

export interface ChainHistory {
  /** Confirmed spends from or payments to the address, oldest first, strictly after the optional transaction ID. */
  getTransactionsAt(address: string, after?: string): Promise<TxRecord[]>;
  /** Exact CBOR hex of a confirmed transaction. Throws when it is unknown. */
  getTransactionCbor(txId: string): Promise<string>;
}
