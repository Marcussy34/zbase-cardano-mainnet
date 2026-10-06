import { ApiError } from './types.js';
import type {
  AspLeavesPage, DepositView, ErrorCode, IntentRequest, LeavesPage, NullifiersPage,
  PayoutRequest, PoolConfigView, PoolView, ProofHex, Quote, SettleRequest, SettleStatus, SpendPublicInputs,
} from './types.js';

export type Json<T> = T extends bigint ? string : T extends (infer U)[] ? Json<U>[]
  : T extends object ? { [K in keyof T]: Json<T[K]> } : T;

function invalid(field: string, expected: string): never {
  throw new ApiError('bad_request', `${field}: expected ${expected}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(field, 'an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') return invalid(field, 'a string');
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(field, 'a non-negative safe integer');
  return value;
}

function decimal(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return invalid(field, 'a non-negative decimal integer string');
  return BigInt(value);
}

function hex(value: unknown, length: number, field: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    return invalid(field, `${length} lowercase hex characters`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return invalid(field, 'a boolean');
  return value;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return invalid(field, choices.join(' or '));
  return value as T;
}

function nullable<T>(value: unknown, parse: (value: unknown, field: string) => T, field: string): T | null {
  return value === null ? null : parse(value, field);
}

function array<T>(value: unknown, parse: (value: unknown, field: string) => T, field: string): T[] {
  if (!Array.isArray(value)) return invalid(field, 'an array');
  return value.map((item: unknown, index) => parse(item, `${field}[${index}]`));
}

const hex28 = (value: unknown, field: string) => hex(value, 56, field);
const hex32 = (value: unknown, field: string) => hex(value, 64, field);

export function poolConfigViewToJson(value: PoolConfigView): Json<PoolConfigView> {
  return {
    depositsPaused: value.depositsPaused, minDeposit: value.minDeposit.toString(), maxDeposit: value.maxDeposit.toString(),
    poolCap: value.poolCap.toString(), depositFeeBps: value.depositFeeBps, settleFeeBps: value.settleFeeBps,
    crankFee: value.crankFee.toString(),
  };
}

export function poolConfigViewFromJson(value: unknown, field = 'config'): PoolConfigView {
  const v = object(value, field);
  return {
    depositsPaused: boolean(v.depositsPaused, `${field}.depositsPaused`), minDeposit: decimal(v.minDeposit, `${field}.minDeposit`),
    maxDeposit: decimal(v.maxDeposit, `${field}.maxDeposit`), poolCap: decimal(v.poolCap, `${field}.poolCap`),
    depositFeeBps: integer(v.depositFeeBps, `${field}.depositFeeBps`), settleFeeBps: integer(v.settleFeeBps, `${field}.settleFeeBps`),
    crankFee: decimal(v.crankFee, `${field}.crankFee`),
  };
}

export function poolViewToJson(value: PoolView): Json<PoolView> {
  return {
    poolId: value.poolId, asset: value.asset, roots: value.roots.map(String), size: value.size, queue: value.queue.map(String),
    nullifierRoot: value.nullifierRoot, feesAccrued: value.feesAccrued.toString(), aspRoot: value.aspRoot.toString(),
    config: poolConfigViewToJson(value.config), tip: { slot: value.tip.slot, hash: value.tip.hash },
  };
}

export function poolViewFromJson(value: unknown, field = 'pool'): PoolView {
  const v = object(value, field);
  const tip = object(v.tip, `${field}.tip`);
  const asset = string(v.asset, `${field}.asset`);
  if (asset !== 'lovelace' && !/^[0-9a-f]{56}\.([0-9a-f]{2}){0,32}$/.test(asset)) {
    return invalid(`${field}.asset`, 'lovelace or a policy ID and asset name in lowercase hex');
  }
  return {
    poolId: hex28(v.poolId, `${field}.poolId`), asset, roots: array(v.roots, decimal, `${field}.roots`),
    size: integer(v.size, `${field}.size`), queue: array(v.queue, decimal, `${field}.queue`),
    nullifierRoot: hex32(v.nullifierRoot, `${field}.nullifierRoot`), feesAccrued: decimal(v.feesAccrued, `${field}.feesAccrued`),
    aspRoot: decimal(v.aspRoot, `${field}.aspRoot`), config: poolConfigViewFromJson(v.config, `${field}.config`),
    tip: { slot: integer(tip.slot, `${field}.tip.slot`), hash: hex32(tip.hash, `${field}.tip.hash`) },
  };
}

export function leavesPageToJson(value: LeavesPage): Json<LeavesPage> {
  return { from: value.from, leaves: value.leaves.map(String), size: value.size, root: value.root.toString() };
}

export function leavesPageFromJson(value: unknown, field = 'leaves'): LeavesPage {
  const v = object(value, field);
  return { from: integer(v.from, `${field}.from`), leaves: array(v.leaves, decimal, `${field}.leaves`),
    size: integer(v.size, `${field}.size`), root: decimal(v.root, `${field}.root`) };
}

export function aspLeavesPageToJson(value: AspLeavesPage): Json<AspLeavesPage> {
  return { from: value.from, leaves: value.leaves.map(String), root: value.root.toString() };
}

export function aspLeavesPageFromJson(value: unknown, field = 'aspLeaves'): AspLeavesPage {
  const v = object(value, field);
  return { from: integer(v.from, `${field}.from`), leaves: array(v.leaves, decimal, `${field}.leaves`), root: decimal(v.root, `${field}.root`) };
}

export function depositViewToJson(value: DepositView): Json<DepositView> {
  return { txId: value.txId, index: value.index, gross: value.gross.toString(), precommitment: value.precommitment.toString(),
    refundKeyHash: value.refundKeyHash, status: value.status, value: value.value?.toString() ?? null,
    label: value.label?.toString() ?? null, leafIndex: value.leafIndex };
}

export function depositViewFromJson(value: unknown, field = 'deposit'): DepositView {
  const v = object(value, field);
  return { txId: hex32(v.txId, `${field}.txId`), index: integer(v.index, `${field}.index`), gross: decimal(v.gross, `${field}.gross`),
    precommitment: decimal(v.precommitment, `${field}.precommitment`), refundKeyHash: hex28(v.refundKeyHash, `${field}.refundKeyHash`),
    status: oneOf(v.status, ['pending', 'absorbed', 'refunded'], `${field}.status`), value: nullable(v.value, decimal, `${field}.value`),
    label: nullable(v.label, decimal, `${field}.label`), leafIndex: nullable(v.leafIndex, integer, `${field}.leafIndex`) };
}

export function nullifiersPageToJson(value: NullifiersPage): Json<NullifiersPage> {
  return { from: value.from, nullifiers: value.nullifiers.map(String) };
}

export function nullifiersPageFromJson(value: unknown, field = 'nullifiers'): NullifiersPage {
  const v = object(value, field);
  return { from: integer(v.from, `${field}.from`), nullifiers: array(v.nullifiers, decimal, `${field}.nullifiers`) };
}

export function payoutRequestToJson(value: PayoutRequest): Json<PayoutRequest> {
  return { address: value.address, amount: value.amount.toString(), datumHash: value.datumHash };
}

export function payoutRequestFromJson(value: unknown, field = 'payout'): PayoutRequest {
  const v = object(value, field);
  return { address: string(v.address, `${field}.address`), amount: decimal(v.amount, `${field}.amount`),
    datumHash: nullable(v.datumHash, hex32, `${field}.datumHash`) };
}

export function quoteToJson(value: Quote): Json<Quote> {
  return { quoteId: value.quoteId, poolId: value.poolId, withdrawn: value.withdrawn.toString(), protocolFee: value.protocolFee.toString(),
    relayerFee: value.relayerFee.toString(), relayerKeyHash: value.relayerKeyHash, validUntil: value.validUntil };
}

export function quoteFromJson(value: unknown, field = 'quote'): Quote {
  const v = object(value, field);
  return { quoteId: string(v.quoteId, `${field}.quoteId`), poolId: hex28(v.poolId, `${field}.poolId`), withdrawn: decimal(v.withdrawn, `${field}.withdrawn`),
    protocolFee: decimal(v.protocolFee, `${field}.protocolFee`), relayerFee: decimal(v.relayerFee, `${field}.relayerFee`),
    relayerKeyHash: hex28(v.relayerKeyHash, `${field}.relayerKeyHash`), validUntil: integer(v.validUntil, `${field}.validUntil`) };
}

export function proofHexToJson(value: ProofHex): Json<ProofHex> {
  return { a: value.a, b: value.b, c: value.c };
}

export function proofHexFromJson(value: unknown, field = 'proof'): ProofHex {
  const v = object(value, field);
  return { a: hex(v.a, 96, `${field}.a`), b: hex(v.b, 192, `${field}.b`), c: hex(v.c, 96, `${field}.c`) };
}

export function spendPublicInputsToJson(value: SpendPublicInputs): Json<SpendPublicInputs> {
  return { newCommitment: value.newCommitment.toString(), nullifierHash: value.nullifierHash.toString(), withdrawn: value.withdrawn.toString(),
    stateRoot: value.stateRoot.toString(), aspRoot: value.aspRoot.toString(), context: value.context.toString() };
}

export function spendPublicInputsFromJson(value: unknown, field = 'publicInputs'): SpendPublicInputs {
  const v = object(value, field);
  return { newCommitment: decimal(v.newCommitment, `${field}.newCommitment`), nullifierHash: decimal(v.nullifierHash, `${field}.nullifierHash`),
    withdrawn: decimal(v.withdrawn, `${field}.withdrawn`), stateRoot: decimal(v.stateRoot, `${field}.stateRoot`),
    aspRoot: decimal(v.aspRoot, `${field}.aspRoot`), context: decimal(v.context, `${field}.context`) };
}

export function intentRequestToJson(value: IntentRequest): Json<IntentRequest> {
  return { poolId: value.poolId, payouts: value.payouts.map(payoutRequestToJson), relayer: value.relayer, validUntil: value.validUntil };
}

export function intentRequestFromJson(value: unknown, field = 'intent'): IntentRequest {
  const v = object(value, field);
  return { poolId: hex28(v.poolId, `${field}.poolId`), payouts: array(v.payouts, payoutRequestFromJson, `${field}.payouts`),
    relayer: nullable(v.relayer, hex28, `${field}.relayer`), validUntil: integer(v.validUntil, `${field}.validUntil`) };
}

export function settleRequestToJson(value: SettleRequest): Json<SettleRequest> {
  return { quoteId: value.quoteId, proof: proofHexToJson(value.proof), publicInputs: spendPublicInputsToJson(value.publicInputs),
    intent: intentRequestToJson(value.intent) };
}

export function settleRequestFromJson(value: unknown, field = 'settle'): SettleRequest {
  const v = object(value, field);
  return { quoteId: string(v.quoteId, `${field}.quoteId`), proof: proofHexFromJson(v.proof, `${field}.proof`),
    publicInputs: spendPublicInputsFromJson(v.publicInputs, `${field}.publicInputs`), intent: intentRequestFromJson(v.intent, `${field}.intent`) };
}

export function settleStatusToJson(value: SettleStatus): Json<SettleStatus> {
  return { id: value.id, status: value.status, txHash: value.txHash, confirmations: value.confirmations, error: value.error };
}

export function settleStatusFromJson(value: unknown, field = 'settleStatus'): SettleStatus {
  const v = object(value, field);
  return { id: string(v.id, `${field}.id`), status: oneOf(v.status, ['submitted', 'confirmed', 'failed'], `${field}.status`),
    txHash: hex32(v.txHash, `${field}.txHash`), confirmations: integer(v.confirmations, `${field}.confirmations`),
    error: nullable(v.error, string, `${field}.error`) };
}

export function errorToJson(error: ApiError): { error: { code: ErrorCode; message: string } } {
  return { error: { code: error.code, message: error.message } };
}

export function errorFromJson(value: unknown, status?: number): ApiError {
  const v = object(object(value, 'response').error, 'error');
  const code = oneOf(v.code, ['stale_root', 'stale_asp_root', 'nullifier_spent', 'queue_full', 'quote_expired',
    'invalid_proof', 'intent_mismatch', 'not_found', 'bad_request', 'internal'], 'error.code');
  return new ApiError(code, string(v.message, 'error.message'), status);
}
