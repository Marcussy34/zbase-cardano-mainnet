import { isDeepStrictEqual } from 'node:util';
import {
  ApiError, indexerRoutes, serveJson, type AspLeavesPage, type DepositView,
  type IndexerApi, type LeavesPage, type NullifiersPage, type PoolView,
} from '@zx402/api';
import { MerkleTree, R, h3, labelFor } from '@zx402/crypto';
import {
  decodeConfigDatum, decodeDepositDatum, decodePoolDatum, decodePoolRedeemer, decodeTx,
  nullifierRoot, readAsp, readConfig, readDeposits, readPool,
  type ChainContext, type ChainHistory, type ConfigDatum, type PoolDatum,
  type TxOutputView, type TxView, type UtxoRef,
} from '@zx402/txlib';

interface Options {
  ctx: ChainContext;
  history: ChainHistory;
  aspLeaves?: (root: bigint) => bigint[] | Promise<bigint[]>;
  settleMs?: number;
  activeMs?: number;
  now?: () => number;
}
interface Snapshot {
  tree: MerkleTree;
  spent: bigint[];
  deposits: Map<string, { view: DepositView; observedSlot: number }>;
  poolRef?: UtxoRef;
  datum?: PoolDatum;
  config?: ConfigDatum;
  poolCursor?: string;
  depositCursor?: string;
  pool?: PoolView;
  aspLeaves: bigint[];
  aspLeavesMatch: boolean;
}
const refKey = (ref: UtxoRef): string => `${ref.txId}#${ref.index}`;
const sameRef = (a: UtxoRef, b: UtxoRef): boolean => a.txId === b.txId && a.index === b.index;
const fresh = (): Snapshot => ({ tree: MerkleTree.empty(), spent: [], deposits: new Map(), aspLeaves: [], aspLeavesMatch: false });

function page(from: number, limit: number): number {
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new ApiError('bad_request', 'from must be nonnegative and limit must be positive safe integers');
  }
  return Math.min(limit, 1_000);
}

/** Replays confirmed history into a snapshot. Failed reads never publish a partial tree. */
export class Indexer implements IndexerApi {
  private readonly options: Options & { settleMs: number; activeMs: number; now: () => number };
  // Transaction contents stay valid across failed syncs and rollbacks. Inclusion belongs to the snapshot.
  private readonly transactions = new Map<string, TxView>();
  private state = fresh();
  private syncing?: Promise<number>;
  private lastSyncedAt: number | undefined;
  private activeUntil = 0;
  private refreshedAt = 0;
  private secondLook = false;

  get syncedAt(): number | undefined { return this.lastSyncedAt; }

  constructor(a: Options) {
    this.options = { ...a, settleMs: a.settleMs ?? 5_000, activeMs: a.activeMs ?? 120_000, now: a.now ?? Date.now };
  }

  /** Allow a second look while a submitted transaction catches up with the address index. */
  expectChange(): void { this.activeUntil = this.options.now() + this.options.activeMs; }

  sync(): Promise<number> {
    if (this.syncing) return this.syncing;
    this.syncing = this.refresh().then(applied => {
      this.lastSyncedAt = this.options.now();
      return applied;
    }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private async transaction(txId: string): Promise<TxView> {
    const cached = this.transactions.get(txId);
    if (cached) return cached;
    const tx = decodeTx(await this.options.history.getTransactionCbor(txId));
    if (tx.txId !== txId) throw new Error('History returned a different transaction ID');
    this.transactions.set(txId, tx);
    return tx;
  }

  private async output(ref: UtxoRef): Promise<TxOutputView> {
    const output = (await this.transaction(ref.txId)).outputs[ref.index];
    if (!output) throw new Error(`Missing historical output ${refKey(ref)}`);
    return output;
  }

  private rememberDeposit(state: Snapshot, ref: UtxoRef, output: TxOutputView, slot: number): DepositView | undefined {
    if (output.address !== this.options.ctx.deployment.scripts.deposit.address || output.inlineDatum === null) return;
    let datum;
    try { datum = decodeDepositDatum(output.inlineDatum); }
    catch { return; } // Unsolicited malformed outputs are not deposits.
    const key = refKey(ref);
    const existing = state.deposits.get(key);
    if (existing) return existing.view;
    const { policy, name } = this.options.ctx.deployment.asset;
    const view: DepositView = {
      ...ref, gross: policy === '' && name === '' ? output.value.lovelace : output.value.assets[policy + name] ?? 0n,
      precommitment: datum.precommitment, refundKeyHash: datum.refund,
      status: 'pending', value: null, label: null, leafIndex: null,
    };
    // ChainHistory exposes block heights, not slots. This is the slot of observation.
    state.deposits.set(key, { view, observedSlot: slot });
    return view;
  }

  private async insertConfig(tx: TxView): Promise<ConfigDatum> {
    const { poolId, scripts } = this.options.ctx.deployment;
    const nft = poolId + Buffer.from('config').toString('hex');
    for (const ref of tx.referenceInputs) {
      const output = await this.output(ref);
      if (output.address === scripts.config.address && output.value.assets[nft] === 1n && output.inlineDatum !== null) {
        // Replays must use the config that governed this Insert, including old fee rates.
        return decodeConfigDatum(output.inlineDatum);
      }
    }
    throw new Error('Insert has no historical config reference');
  }

  private async apply(state: Snapshot, tx: TxView, slot: number): Promise<boolean> {
    const { deployment } = this.options.ctx;
    let inputIndex = -1;
    if (state.poolRef) inputIndex = tx.inputs.findIndex(ref => sameRef(ref, state.poolRef!));
    if (tx.txId !== deployment.initTx && inputIndex < 0) return false;
    const output = tx.outputs[0];
    const nft = deployment.poolId + Buffer.from('pool').toString('hex');
    if (!output || output.address !== deployment.scripts.pool.address || output.value.assets[nft] !== 1n || output.inlineDatum === null) {
      throw new Error('Missing continuing pool output');
    }
    const next = decodePoolDatum(output.inlineDatum);
    if (tx.txId === deployment.initTx) {
      if (state.poolRef || next.size !== 0 || next.queue.length !== 0) throw new Error('Invalid pool genesis');
    } else {
      const previous = state.datum!;
      const redeemer = tx.redeemers.find(entry => entry.tag === 'spend' && entry.index === inputIndex);
      if (!redeemer) throw new Error('Missing pool spend redeemer');
      const action = decodePoolRedeemer(redeemer.dataCbor);
      if (action.kind === 'Insert') {
        if (action.flush < 0 || action.flush > previous.queue.length) throw new Error('Invalid Insert flush count');
        for (const leaf of previous.queue.slice(0, action.flush)) state.tree.append(leaf);
        const config = await this.insertConfig(tx);
        // Only script inputs can be deposits. Fee inputs may originate outside address history.
        const scriptInputs = new Set(tx.redeemers.filter(r => r.tag === 'spend').map(r => r.index));
        for (const [index, ref] of tx.inputs.entries()) {
          if (index === inputIndex || !scriptInputs.has(index)) continue;
          const depositOutput = await this.output(ref);
          if (depositOutput.address !== deployment.scripts.deposit.address) continue;
          const deposit = this.rememberDeposit(state, ref, depositOutput, slot);
          if (!deposit) throw new Error('Absorbed deposit has an invalid datum');
          if (deposit.precommitment <= 0n || deposit.precommitment >= R
            || deposit.gross < config.minDeposit || deposit.gross > config.maxDeposit) throw new Error('Invalid absorbed deposit');
          const fee = deposit.gross * BigInt(config.depositFeeBps) / 10_000n;
          const isAda = deployment.asset.policy === '' && deployment.asset.name === '';
          const value = deposit.gross - fee - (isAda ? config.crankFee : 0n);
          const label = labelFor({ poolId: Buffer.from(deployment.poolId, 'hex'), txId: Buffer.from(ref.txId, 'hex'),
            outputIndex: ref.index, refundKeyHash: Buffer.from(deposit.refundKeyHash, 'hex') });
          if (value <= 0n || label === 0n) throw new Error('Invalid credited deposit');
          Object.assign(deposit, { status: 'absorbed', value, label,
            leafIndex: state.tree.append(h3(value, label, deposit.precommitment)) });
          state.deposits.get(refKey(ref))!.observedSlot = slot;
        }
      } else if (action.kind === 'Settle' || action.kind === 'Ragequit') {
        if (state.spent.includes(action.nullifierHash)) throw new Error('Duplicate spent nullifier');
        state.spent.push(action.nullifierHash);
      }
    }
    if (state.tree.root !== next.roots[0] || state.tree.size !== next.size) throw new Error('Rebuilt state tree does not match pool datum');
    if (await nullifierRoot(state.spent) !== next.nullifierRoot) throw new Error('Rebuilt nullifier root does not match pool datum');
    state.poolRef = { txId: tx.txId, index: 0 };
    state.datum = next;
    return true;
  }

  private async refreshAsp(state: Snapshot, root: bigint): Promise<void> {
    const leaves = [...await (this.options.aspLeaves?.(root) ?? [])];
    const unchanged = root === this.state.pool?.aspRoot && leaves.length === this.state.aspLeaves.length
      && leaves.every((leaf, index) => leaf === this.state.aspLeaves[index]);
    state.aspLeavesMatch = unchanged ? this.state.aspLeavesMatch : MerkleTree.fromLeaves(leaves).root === root;
    state.aspLeaves = leaves;
  }

  private async refresh(): Promise<number> {
    const { ctx, history } = this.options;
    const { scripts, asset, poolId } = ctx.deployment;
    const tip = await ctx.provider.getTip();
    const sameTip = tip.blockHash === this.state.pool?.tip.hash;
    const now = this.options.now();
    if (sameTip && (now >= this.activeUntil || this.secondLook || now - this.refreshedAt < this.options.settleMs)) {
      const state = { ...this.state };
      await this.refreshAsp(state, this.state.pool!.aspRoot);
      this.state = state;
      return 0;
    }
    let state: Snapshot = { ...this.state, tree: this.state.tree.clone(), spent: [...this.state.spent],
      deposits: structuredClone(this.state.deposits) };
    const lists = await Promise.allSettled([
      history.getTransactionsAt(scripts.pool.address, state.poolCursor),
      history.getTransactionsAt(scripts.deposit.address, state.depositCursor),
    ]);
    let poolRecords;
    let depositRecords;
    if (lists[0].status === 'rejected' || lists[1].status === 'rejected') {
      // Confirm a missing cursor before treating a provider failure as rollback.
      const all = await Promise.all([
        history.getTransactionsAt(scripts.pool.address), history.getTransactionsAt(scripts.deposit.address),
      ]);
      const poolGone = state.poolCursor && !all[0].some(tx => tx.txId === state.poolCursor);
      const depositGone = state.depositCursor && !all[1].some(tx => tx.txId === state.depositCursor);
      if (!poolGone && !depositGone) {
        throw lists[0].status === 'rejected' ? lists[0].reason : lists[1].status === 'rejected' ? lists[1].reason : new Error('History failed');
      }
      state = fresh();
      [poolRecords, depositRecords] = all;
    } else {
      poolRecords = lists[0].value;
      depositRecords = lists[1].value;
    }
    // Replay deposit creation and refunds even if both happened between polls.
    for (const record of depositRecords) {
      const tx = await this.transaction(record.txId);
      for (const ref of tx.inputs) {
        const deposit = state.deposits.get(refKey(ref));
        if (deposit && deposit.view.status === 'pending') {
          deposit.view.status = 'refunded';
          deposit.observedSlot = tip.slot;
        }
      }
      tx.outputs.forEach((output, index) => this.rememberDeposit(state, { txId: tx.txId, index }, output, tip.slot));
      state.depositCursor = tx.txId;
    }
    let applied = 0;
    for (const record of poolRecords) {
      const tx = await this.transaction(record.txId);
      if (await this.apply(state, tx, tip.slot)) applied += 1;
      state.poolCursor = tx.txId;
    }
    const [pool, config, asp, pending] = await Promise.all([
      readPool(ctx), readConfig(ctx), readAsp(ctx), readDeposits(ctx),
    ]);
    await this.refreshAsp(state, asp.datum.root);
    const endTip = await ctx.provider.getTip();
    if (!state.poolRef || !sameRef(pool.utxo.ref, state.poolRef)) throw new Error('Pool history has not reached the current pool UTXO');
    if (tip.blockHash !== endTip.blockHash) throw new Error('Chain tip changed during sync; retry on the next poll');
    const pendingRefs = new Set(pending.map(d => refKey(d.utxo.ref)));
    for (const { utxo } of pending) this.rememberDeposit(state, utxo.ref, utxo, tip.slot);
    for (const [key, deposit] of state.deposits) {
      if (deposit.view.status === 'pending' && !pendingRefs.has(key)) {
        deposit.view.status = 'refunded';
        deposit.observedSlot = tip.slot;
      }
    }
    const { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee } = config.datum;
    state.pool = {
      poolId, asset: asset.policy === '' && asset.name === '' ? 'lovelace' : `${asset.policy}.${asset.name}`,
      ...structuredClone(pool.datum), aspRoot: asp.datum.root,
      config: { depositsPaused, minDeposit, maxDeposit, poolCap, depositFeeBps, settleFeeBps, crankFee },
      tip: { slot: endTip.slot, hash: endTip.blockHash },
    };
    state.config = config.datum;
    // A new tip alone is not activity. Compare only the pool, approval, config and deposits.
    if (!isDeepStrictEqual(state.poolRef, this.state.poolRef) || state.pool.aspRoot !== this.state.pool?.aspRoot
      || !isDeepStrictEqual(state.config, this.state.config) || !isDeepStrictEqual(state.deposits, this.state.deposits)) {
      this.expectChange();
    }
    this.state = state;
    this.refreshedAt = this.options.now();
    this.secondLook = sameTip;
    return applied;
  }

  private ready(): PoolView {
    if (!this.state.pool) throw new ApiError('internal', 'Indexer has not synced');
    return this.state.pool;
  }

  async getPool(): Promise<PoolView> { return structuredClone(this.ready()); }
  async getLeaves(from: number, limit: number): Promise<LeavesPage> {
    const count = page(from, limit);
    this.ready();
    const { tree } = this.state;
    return { from, leaves: Array.from({ length: Math.max(0, Math.min(count, tree.size - from)) }, (_, i) => tree.leaf(from + i)),
      size: tree.size, root: tree.root };
  }
  async getAspLeaves(from: number, limit: number): Promise<AspLeavesPage> {
    const count = page(from, limit);
    const pool = this.ready();
    if (!this.state.aspLeavesMatch) {
      throw new ApiError('stale_asp_root', 'Approved leaves do not match the confirmed ASP root');
    }
    return { from, leaves: this.state.aspLeaves.slice(from, from + count), root: pool.aspRoot };
  }
  async getDeposits(fromSlot?: number): Promise<DepositView[]> {
    this.ready();
    if (fromSlot !== undefined && (!Number.isSafeInteger(fromSlot) || fromSlot < 0)) throw new ApiError('bad_request', 'fromSlot must be a nonnegative safe integer');
    return [...this.state.deposits.values()].filter(d => fromSlot === undefined || d.observedSlot >= fromSlot)
      .map(d => structuredClone(d.view));
  }
  async getNullifiers(from: number, limit: number): Promise<NullifiersPage> {
    const count = page(from, limit);
    this.ready();
    return { from, nullifiers: this.state.spent.slice(from, from + count) };
  }
  tree(): MerkleTree { return this.state.tree.clone(); }
  spent(): bigint[] { return [...this.state.spent]; }
}

/** Poll only after the previous sync finishes so slow providers do not accumulate requests. */
export async function serveIndexer(indexer: Indexer, a: {
  port: number; syncMs?: number; maxStaleMs?: number; onError?: (error: unknown) => void;
}): Promise<{ url: string; close(): Promise<void> }> {
  const syncMs = a.syncMs ?? 5_000;
  const maxStaleMs = a.maxStaleMs ?? 120_000;
  const onError = a.onError ?? (() => {});
  if (!Number.isSafeInteger(syncMs) || syncMs < 0 || syncMs > 2_147_483_647) throw new RangeError('syncMs must be a nonnegative timer interval');
  for (let attempt = 0; syncMs > 0 && attempt < 5; attempt += 1) {
    try {
      await indexer.sync();
      break;
    } catch (error) {
      onError(error);
      if (attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, syncMs));
    }
  }
  const server = await serveJson(indexerRoutes(indexer).map(route => ({ ...route, handle: request => {
    if (indexer.syncedAt === undefined || Date.now() - indexer.syncedAt > maxStaleMs) {
      throw new ApiError('internal', 'Indexer snapshot is too old', 503);
    }
    return route.handle(request);
  } })), a.port);
  let closed = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      running = indexer.sync().then(() => {}, onError)
        .finally(() => { if (!closed) schedule(); });
    }, syncMs);
    timer.unref();
  };
  if (syncMs > 0) schedule();
  return { url: server.url, async close() {
    closed = true;
    clearTimeout(timer);
    await server.close();
    await running;
  } };
}
