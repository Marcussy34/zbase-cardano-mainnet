import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import {
  ApiError, type IndexerApi, type IntentRequest, type PayoutRequest, type PoolView, type ProofHex,
  type Quote, type RelayerApi, type SettleRequest, type SettleStatus,
} from '@zbase-cardano/api';
import {
  addressFromBech32, contextFor, type CardanoProof, type SettleIntent, type SnarkjsProof, type SnarkjsVk,
} from '@zbase-cardano/crypto';
import { verify } from '@zbase-cardano/prover';
import {
  buildSettle, enterpriseAddress, keyHash, nullifierInsertion, readPool, signTx,
  type ChainContext, type PoolState, type UtxoRef,
} from '@zbase-cardano/txlib';

interface StoredQuote { quote: Quote; payouts: PayoutRequest[] }
interface Submission { status: SettleStatus; nullifier: bigint }
const sameRef = (a: UtxoRef, b: UtxoRef) => a.txId === b.txId && a.index === b.index;

function proofBytes(proof: ProofHex): CardanoProof {
  const bytes = (value: string, length: number) => {
    if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) {
      throw new Error('Invalid compressed proof');
    }
    return Buffer.from(value, 'hex');
  };
  return { a: bytes(proof.a, 48), b: bytes(proof.b, 96), c: bytes(proof.c, 48) };
}

/** The API carries compressed points; snarkjs verifies affine coordinates. */
function snarkjsProof(proof: CardanoProof): SnarkjsProof {
  const a = bls12_381.G1.Point.fromBytes(proof.a);
  const b = bls12_381.G2.Point.fromBytes(proof.b);
  const c = bls12_381.G1.Point.fromBytes(proof.c);
  for (const point of [a, b, c]) {
    point.assertValidity();
    if (point.is0()) throw new Error('Proof points must not be infinity');
  }
  const aa = a.toAffine();
  const bb = b.toAffine();
  const cc = c.toAffine();
  return { pi_a: [String(aa.x), String(aa.y), '1'],
    pi_b: [[String(bb.x.c0), String(bb.x.c1)], [String(bb.y.c0), String(bb.y.c1)], ['1', '0']],
    pi_c: [String(cc.x), String(cc.y), '1'], protocol: 'groth16', curve: 'bls12381' };
}

export class Relayer implements RelayerApi {
  private readonly ctx: ChainContext;
  private readonly indexer: IndexerApi;
  private readonly seed: Uint8Array;
  private readonly vkey: SnarkjsVk;
  private readonly relayerFee: bigint;
  private readonly quoteTtlMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly relayerKeyHash: string;
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly submissions = new Map<string, Submission>();
  private serial: Promise<unknown> = Promise.resolve();
  private pendingPool: { ref: UtxoRef; validUntil: number } | undefined;

  constructor(a: {
    ctx: ChainContext; indexer: IndexerApi; seed: Uint8Array; vkey: SnarkjsVk;
    relayerFee?: bigint; quoteTtlMs?: number; retryDelayMs?: number; now?: () => number;
  }) {
    this.ctx = a.ctx;
    this.indexer = a.indexer;
    this.seed = a.seed.slice();
    this.vkey = a.vkey;
    this.relayerFee = a.relayerFee ?? 1_000_000n;
    this.quoteTtlMs = a.quoteTtlMs ?? 120_000;
    this.retryDelayMs = a.retryDelayMs ?? 20_000;
    this.now = a.now ?? Date.now;
    this.relayerKeyHash = Buffer.from(keyHash(this.seed)).toString('hex');
    if (this.relayerFee < 0n || !Number.isSafeInteger(this.quoteTtlMs) || this.quoteTtlMs <= 0
      || !Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 1) {
      throw new RangeError('Fees must be nonnegative and delays must be positive safe integers');
    }
  }

  getPool(): Promise<PoolView> { return this.indexer.getPool(); }

  async quote(payouts: PayoutRequest[]): Promise<Quote> {
    if (!Array.isArray(payouts) || payouts.length < 1 || payouts.length > 4) {
      throw new ApiError('bad_request', 'A quote requires one to four payouts');
    }
    const saved = payouts.map(payout => {
      try {
        addressFromBech32(payout.address, this.ctx.deployment.network);
        if (typeof payout.amount !== 'bigint' || payout.amount < 1_000_000n) throw new Error('Invalid amount');
        if (payout.datumHash !== null && !/^[0-9a-f]{64}$/.test(payout.datumHash)) throw new Error('Invalid datum hash');
      } catch {
        throw new ApiError('bad_request', 'Payouts need a valid network address, datum hash, and at least 1000000 lovelace');
      }
      return { ...payout };
    });
    const view = await this.getPool();
    const paid = saved.reduce((sum, payout) => sum + payout.amount, 0n);
    const protocolFee = paid * BigInt(view.config.settleFeeBps) / 10_000n;
    const withdrawn = paid + protocolFee + this.relayerFee;
    if (withdrawn >= 1n << 64n) throw new ApiError('bad_request', 'Withdrawal must fit in 64 bits');
    const quote: Quote = { quoteId: randomUUID(), poolId: this.ctx.deployment.poolId, withdrawn, protocolFee,
      relayerFee: this.relayerFee, relayerKeyHash: this.relayerKeyHash, validUntil: this.now() + this.quoteTtlMs };
    this.quotes.set(quote.quoteId, { quote, payouts: saved });
    return { ...quote };
  }

  settle(request: SettleRequest): Promise<SettleStatus> {
    // Callers can mutate their own objects while another request waits for the pool.
    const snapshot = structuredClone(request);
    const result = this.serial.then(() => this.submit(snapshot));
    this.serial = result.catch(() => undefined);
    return result;
  }

  async getSettle(id: string): Promise<SettleStatus> {
    const entry = this.submissions.get(id);
    if (!entry) throw new ApiError('not_found', 'Settle not found');
    if (entry.status.status !== 'failed') {
      const confirmed = (await this.nullifiers()).includes(entry.nullifier);
      return { ...entry.status, status: confirmed ? 'confirmed' : 'submitted', confirmations: confirmed ? 1 : 0 };
    }
    return { ...entry.status };
  }

  private checkExpiry(quote: Quote): void {
    if (this.now() >= quote.validUntil) throw new ApiError('quote_expired', 'Quote has expired');
  }

  private intent(request: IntentRequest): SettleIntent {
    return { poolId: Buffer.from(request.poolId, 'hex'), relayer: Buffer.from(this.relayerKeyHash, 'hex'),
      validUntil: BigInt(request.validUntil), payouts: request.payouts.map(payout => ({
        address: addressFromBech32(payout.address, this.ctx.deployment.network), amount: payout.amount,
        datumHash: payout.datumHash === null ? null : Buffer.from(payout.datumHash, 'hex'),
      })) };
  }

  private async nullifiers(): Promise<bigint[]> {
    const values: bigint[] = [];
    for (;;) {
      const page = await this.indexer.getNullifiers(values.length, 1000);
      if (page.from !== values.length) throw new ApiError('internal', 'Indexer returned an inconsistent nullifier page');
      if (page.nullifiers.length === 0) return values;
      values.push(...page.nullifiers);
    }
  }

  private async availablePool(quote: Quote): Promise<PoolState> {
    let pool = await readPool(this.ctx);
    // Confirmed reads cannot spend our previous transaction's output until a block arrives.
    while (this.pendingPool && sameRef(pool.utxo.ref, this.pendingPool.ref) && this.now() < this.pendingPool.validUntil) {
      this.checkExpiry(quote);
      await delay(this.retryDelayMs);
      pool = await readPool(this.ctx);
    }
    this.pendingPool = undefined;
    this.checkExpiry(quote);
    return pool;
  }

  private async submit(request: SettleRequest): Promise<SettleStatus> {
    const stored = this.quotes.get(request.quoteId);
    if (!stored) throw new ApiError('not_found', 'Quote not found');
    const { quote, payouts } = stored;
    this.checkExpiry(quote);
    const { intent: proposed, publicInputs: inputs } = request;
    if (proposed.poolId !== quote.poolId || proposed.relayer !== this.relayerKeyHash || proposed.validUntil !== quote.validUntil
      || proposed.payouts.length !== payouts.length || proposed.payouts.some((payout, i) => {
        const expected = payouts[i]!;
        return payout.address !== expected.address || payout.amount !== expected.amount || payout.datumHash !== expected.datumHash;
      })) throw new ApiError('intent_mismatch', 'Intent does not match the quote');
    const intent = this.intent(proposed);
    if (inputs.withdrawn !== quote.withdrawn || inputs.context !== contextFor(intent)) {
      throw new ApiError('intent_mismatch', 'Public inputs do not match the intent');
    }
    let proof: CardanoProof | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let pool: PoolState;
      try { pool = await this.availablePool(quote); }
      catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('internal', 'Could not read the pool');
      }
      const view = await this.getPool();
      if (!view.roots.includes(inputs.stateRoot) || !pool.datum.roots.includes(inputs.stateRoot)) {
        throw new ApiError('stale_root', 'State root is no longer in the pool history');
      }
      if (view.aspRoot !== inputs.aspRoot) throw new ApiError('stale_asp_root', 'ASP root has changed');
      const spent = await this.nullifiers();
      if (spent.includes(inputs.nullifierHash)) throw new ApiError('nullifier_spent', 'Nullifier is already spent');
      if (view.queue.length >= 8 || pool.datum.queue.length >= 8) throw new ApiError('queue_full', 'Pool queue is full');
      if (proof === undefined) {
        try {
          proof = proofBytes(request.proof);
          if (!await verify(this.vkey, [inputs.newCommitment, inputs.nullifierHash, inputs.withdrawn,
            inputs.stateRoot, inputs.aspRoot, inputs.context], snarkjsProof(proof))) throw new Error('Invalid proof');
        } catch {
          throw new ApiError('invalid_proof', 'Spend proof did not verify');
        }
      }
      // The quote ID is also the tracking ID, including when submission throws.
      const status: SettleStatus = { id: quote.quoteId, status: 'failed', txHash: '00'.repeat(32), confirmations: 0, error: null };
      try {
        this.checkExpiry(quote);
        const trie = await nullifierInsertion(spent, inputs.nullifierHash);
        if (trie.oldRoot !== pool.datum.nullifierRoot) throw new Error('Indexer nullifiers are behind the pool');
        const tx = await buildSettle(this.ctx, { payer: { address: enterpriseAddress(this.seed, this.ctx.deployment.network) },
          pool, proof, nullifierHash: inputs.nullifierHash, newCommitment: inputs.newCommitment,
          withdrawn: inputs.withdrawn, stateRoot: inputs.stateRoot, intent,
          nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot });
        status.txHash = tx.txId;
        this.checkExpiry(quote);
        status.txHash = await this.ctx.provider.submit(signTx(tx.cbor, [this.seed]));
        status.status = 'submitted';
        this.submissions.set(status.id, { status, nullifier: inputs.nullifierHash });
        this.pendingPool = { ref: pool.utxo.ref, validUntil: quote.validUntil };
        return { ...status };
      } catch (error) {
        if (error instanceof ApiError && error.code === 'quote_expired') throw error;
        let changed = false;
        try { changed = !sameRef(pool.utxo.ref, (await readPool(this.ctx)).utxo.ref); }
        catch { /* Provider diagnostics must never reach API callers. */ }
        if (changed && attempt < 2) {
          await delay(this.retryDelayMs);
          continue;
        }
        status.error = 'Could not build or submit the settle transaction';
        this.submissions.set(status.id, { status, nullifier: inputs.nullifierHash });
        throw new ApiError('internal', status.error);
      }
    }
    throw new ApiError('internal', 'Settle retry limit reached');
  }
}
