export interface PoolConfigView {
  depositsPaused: boolean;
  minDeposit: bigint;
  maxDeposit: bigint;
  poolCap: bigint;
  depositFeeBps: number;
  settleFeeBps: number;
  crankFee: bigint;
}

export interface PoolView {
  poolId: string; // 56 hex characters.
  asset: string; // lovelace, or policy ID followed by a dot and asset name hex.
  roots: bigint[];
  size: number;
  queue: bigint[];
  nullifierRoot: string; // 64 hex characters.
  feesAccrued: bigint;
  aspRoot: bigint;
  config: PoolConfigView;
  tip: { slot: number; hash: string };
}

export interface LeavesPage { from: number; leaves: bigint[]; size: number; root: bigint }
// A removed label stays in position as 0n.
export interface AspLeavesPage { from: number; leaves: bigint[]; root: bigint }
export interface DepositView {
  txId: string;
  index: number;
  gross: bigint;
  precommitment: bigint;
  refundKeyHash: string;
  status: 'pending' | 'absorbed' | 'refunded';
  value: bigint | null;
  label: bigint | null;
  leafIndex: number | null;
}
export interface NullifiersPage { from: number; nullifiers: bigint[] }

export interface IndexerApi {
  getPool(): Promise<PoolView>;
  getLeaves(from: number, limit: number): Promise<LeavesPage>;
  getAspLeaves(from: number, limit: number): Promise<AspLeavesPage>;
  getDeposits(fromSlot?: number): Promise<DepositView[]>;
  getNullifiers(from: number, limit: number): Promise<NullifiersPage>;
}

export interface PayoutRequest { address: string; amount: bigint; datumHash: string | null }
export interface Quote {
  quoteId: string;
  poolId: string;
  withdrawn: bigint;
  protocolFee: bigint;
  relayerFee: bigint;
  relayerKeyHash: string;
  validUntil: number; // POSIX milliseconds.
}
export interface ProofHex { a: string; b: string; c: string } // 96, 192, 96 hex characters.
export interface SpendPublicInputs {
  newCommitment: bigint;
  nullifierHash: bigint;
  withdrawn: bigint;
  stateRoot: bigint;
  aspRoot: bigint;
  context: bigint;
}
export interface IntentRequest { poolId: string; payouts: PayoutRequest[]; relayer: string | null; validUntil: number }
export interface SettleRequest { quoteId: string; proof: ProofHex; publicInputs: SpendPublicInputs; intent: IntentRequest }
export interface SettleStatus {
  id: string;
  status: 'submitted' | 'confirmed' | 'failed';
  txHash: string;
  confirmations: number;
  error: string | null;
}
export interface RelayerApi {
  getPool(): Promise<PoolView>;
  quote(payouts: PayoutRequest[]): Promise<Quote>;
  settle(request: SettleRequest): Promise<SettleStatus>;
  getSettle(id: string): Promise<SettleStatus>;
}

export type ErrorCode =
  | 'stale_root' | 'stale_asp_root' | 'nullifier_spent' | 'queue_full' | 'quote_expired'
  | 'invalid_proof' | 'intent_mismatch' | 'not_found' | 'bad_request' | 'internal';

const defaultStatuses: Record<ErrorCode, number> = {
  stale_root: 409, stale_asp_root: 409, nullifier_spent: 409, queue_full: 409, quote_expired: 409,
  invalid_proof: 400, intent_mismatch: 400, not_found: 404, bad_request: 400, internal: 500,
};

/** Services throw this error, and HTTP clients reconstruct it with the response status. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number = defaultStatuses[code]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}
