import { setTimeout as delay } from 'node:timers/promises';
import type { ClientCardanoSigner } from '@x402/cardano';
import { ApiError, type DepositView, type IndexerApi, type PayoutRequest, type RelayerApi, type SettleStatus } from '@zbase-cardano/api';
import {
  addressFromBech32, commitment, contextFor, deriveNoteSecrets, MerkleTree, nullifierHash, precommitment,
  ragequitWitness, spendWitness, type Note, type SettleIntent,
} from '@zbase-cardano/crypto';
import { prove, type CircuitArtifacts } from '@zbase-cardano/prover';
import {
  buildDeposit, buildRagequit, buildRefund, encodeDepositDatum, enterpriseAddress, keyHash,
  nullifierInsertion, readDeposits, readPool, signTx, type ChainContext,
} from '@zbase-cardano/txlib';
import { memoryStore, type NoteRecord, type NoteStore, type StoreData } from './store.js';
import { stealthSigner } from './x402.js';

export interface ZbaseOptions {
  seed: Uint8Array;
  ctx: ChainContext;
  indexer: IndexerApi;
  relayer: RelayerApi;
  artifacts: { spend: CircuitArtifacts; ragequit: CircuitArtifacts };
  store?: NoteStore;
  poll?: { intervalMs?: number; timeoutMs?: number; onPoll?: () => void | Promise<void> };
}
export interface PreparedDeposit {
  noteId: string; address: string; amount: bigint; precommitment: bigint; refundKeyHash: string; inlineDatum: string;
}
export interface SettleReceipt { id: string; txHash: string; noteId: string; changeNoteId: string | null; withdrawn: bigint }
type PaymentArgs = { payouts: { address: string; amount: bigint; datumHash?: string | null }[]; noteId?: string };
type ExitArgs = { noteId: string; refundSeed: Uint8Array; payTo?: string };
export interface ZbaseCardano {
  prepareDeposit(a: { amount: bigint; refundKeyHash: string }): Promise<PreparedDeposit>;
  deposit(a: { amount: bigint; walletSeed: Uint8Array }): Promise<{ txId: string; prepared: PreparedDeposit }>;
  sync(): Promise<void>;
  listNotes(): NoteRecord[];
  balance(): { spendable: bigint; pending: bigint };
  waitForNote(noteId: string): Promise<NoteRecord>;
  settlePrivately(a: PaymentArgs): Promise<SettleReceipt>;
  waitForSettle(id: string): Promise<SettleStatus>;
  ragequit(a: ExitArgs): Promise<{ txId: string }>;
  refund(a: ExitArgs): Promise<{ txId: string }>;
  x402Signer(a?: { mode?: 'stealth' }): ClientCardanoSigner;
}

const CHANGE_OFFSET = 2 ** 20;
const PAGE_SIZE = 1000;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fresh = (): StoreData => ({ nextDepositIndex: 0, nextChangeIndex: 0, nextOneTimeIndex: 0, notes: [] });
const terminal = (note: NoteRecord) => ['spent', 'refunded', 'exited'].includes(note.status);

export function createZbaseCardano(o: ZbaseOptions): ZbaseCardano {
  if (!(o.seed instanceof Uint8Array) || o.seed.length !== 32) throw new RangeError('seed must be exactly 32 bytes');
  const seed = o.seed.slice();
  const { ctx, indexer, relayer } = o;
  const store = o.store ?? memoryStore();
  const intervalMs = o.poll?.intervalMs ?? 3000;
  const timeoutMs = o.poll?.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Poll interval must be nonnegative and timeout must be positive');
  }
  let data = fresh();
  let loaded = o.store === undefined;
  let loading: Promise<void> | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  let leaves: bigint[] = [];
  let approved: bigint[] = [];
  let spent: bigint[] = [];
  let approvalKnown = false;

  async function load(): Promise<void> {
    if (loaded) return;
    await (loading ??= (async () => {
      const saved = await store.load();
      if (saved !== null) {
        for (const counter of [saved.nextDepositIndex, saved.nextChangeIndex, saved.nextOneTimeIndex]) {
          if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid store counter');
        }
        if (!Array.isArray(saved.notes)) throw new Error('Invalid stored notes');
        data = structuredClone(saved);
        for (const record of data.notes) {
          if (precommitmentFor(record.secretIndex) !== record.precommitment) throw new Error('Store does not match this seed');
        }
      }
      loaded = true;
    })());
  }
  function current(): StoreData {
    if (!loaded) throw new Error('Store is not loaded. Await sync or another async SDK operation first');
    return data;
  }
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = serial.then(async () => { await load(); return operation(); });
    serial = result.catch(() => undefined);
    return result;
  }
  async function save(next: StoreData): Promise<void> {
    await store.save(next);
    data = next;
  }
  function precommitmentFor(index: number): bigint {
    const secrets = deriveNoteSecrets(seed, index);
    return precommitment(secrets.nullifier, secrets.secret);
  }
  function depositRecord(index: number, gross: bigint | null): NoteRecord {
    return { id: `d${index}`, kind: 'deposit', secretIndex: index, status: 'created', value: null, label: null,
      leafIndex: null, origin: null, gross, precommitment: precommitmentFor(index) };
  }
  function privateNote(record: NoteRecord): Note {
    if (record.value === null || record.label === null) throw new Error(`Note ${record.id} has not been inserted`);
    return { value: record.value, label: record.label, ...deriveNoteSecrets(seed, record.secretIndex) };
  }
  function find(id: string): NoteRecord {
    const record = data.notes.find(n => n.id === id);
    if (!record) throw new Error(`Unknown note ${id}`);
    return record;
  }
  async function prepare(a: { amount: bigint; refundKeyHash: string }): Promise<PreparedDeposit> {
    if (typeof a.amount !== 'bigint' || a.amount <= 0n || a.amount >= 1n << 64n) throw new RangeError('Amount must fit a positive 64-bit value');
    if (!/^[0-9a-f]{56}$/.test(a.refundKeyHash)) throw new Error('Refund key hash must be 28 bytes of lowercase hex');
    if (data.nextDepositIndex >= CHANGE_OFFSET) throw new Error('Deposit derivation indexes are exhausted');
    const record = depositRecord(data.nextDepositIndex, a.amount);
    const inlineDatum = encodeDepositDatum({ precommitment: record.precommitment, refund: a.refundKeyHash });
    await save({ ...data, nextDepositIndex: data.nextDepositIndex + 1, notes: [...data.notes, record] });
    return { noteId: record.id, address: ctx.deployment.scripts.deposit.address, amount: a.amount,
      precommitment: record.precommitment, refundKeyHash: a.refundKeyHash, inlineDatum };
  }
  async function sync(): Promise<void> {
    const pool = await indexer.getPool();
    if (pool.poolId !== ctx.deployment.poolId) throw new Error('Indexer pool does not match the deployment');
    const nextLeaves: bigint[] = [];
    do {
      const page = await indexer.getLeaves(nextLeaves.length, PAGE_SIZE);
      if (page.from !== nextLeaves.length || page.size !== pool.size || page.root !== pool.roots[0]
        || page.leaves.length > pool.size - nextLeaves.length || (!page.leaves.length && nextLeaves.length < pool.size)) {
        throw new Error('Inconsistent state tree page');
      }
      nextLeaves.push(...page.leaves);
    } while (nextLeaves.length < pool.size);
    if (MerkleTree.fromLeaves(nextLeaves).root !== pool.roots[0]) throw new Error('Downloaded state tree root does not match the pool');
    let nextApproved: bigint[] = [];
    let known = true;
    try {
      for (;;) {
        const page = await indexer.getAspLeaves(nextApproved.length, PAGE_SIZE);
        if (page.from !== nextApproved.length || page.root !== pool.aspRoot) throw new ApiError('stale_asp_root', 'Association pages changed');
        if (page.leaves.length === 0) break;
        nextApproved.push(...page.leaves);
      }
      if (MerkleTree.fromLeaves(nextApproved).root !== pool.aspRoot) throw new Error('Downloaded association tree root does not match the pool');
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'stale_asp_root') throw error;
      known = false;
      nextApproved = approved;
    }
    const nextSpent: bigint[] = [];
    for (;;) {
      const page = await indexer.getNullifiers(nextSpent.length, PAGE_SIZE);
      if (page.from !== nextSpent.length) throw new Error('Inconsistent nullifier page');
      if (page.nullifiers.length === 0) break;
      nextSpent.push(...page.nullifiers);
    }
    const deposits = await indexer.getDeposits();
    const next = structuredClone(data);
    const byPrecommitment = new Map<bigint, DepositView>();
    // Reusing a precommitment shares its nullifier. Prefer the largest credited deposit.
    for (const deposit of deposits) {
      const old = byPrecommitment.get(deposit.precommitment);
      if (!old || (deposit.value ?? deposit.gross) > (old.value ?? old.gross)) byPrecommitment.set(deposit.precommitment, deposit);
    }
    if (next.notes.length === 0) {
      let misses = 0;
      for (let i = 0; misses < 10 && i < CHANGE_OFFSET; i++) {
        const record = depositRecord(i, null);
        if (byPrecommitment.has(record.precommitment)) {
          next.notes.push(record);
          next.nextDepositIndex = Math.max(next.nextDepositIndex, i + 1);
          misses = 0;
        } else { misses++; }
      }
    }
    const approvedSet = new Set(nextApproved.filter(label => label !== 0n));
    const spentSet = new Set(nextSpent);
    for (const record of next.notes) {
      const previousStatus = record.status;
      if (record.kind === 'deposit') {
        const deposit = byPrecommitment.get(record.precommitment);
        if (deposit) {
          record.origin = { txId: deposit.txId, index: deposit.index, refundKeyHash: deposit.refundKeyHash };
          record.gross = deposit.gross;
          if (deposit.status === 'absorbed') {
            record.value = deposit.value;
            record.label = deposit.label;
            record.leafIndex = deposit.leafIndex;
            if (record.value === null || record.label === null || record.leafIndex === null) throw new Error('Absorbed deposit is missing note data');
            if (!terminal(record)) record.status = 'inserted';
          } else if (!terminal(record)) { record.status = deposit.status === 'pending' ? 'deposited' : 'refunded'; }
        }
      } else if (record.value !== null && record.label !== null) {
        const index = nextLeaves.indexOf(commitment(privateNote(record)));
        if (index >= 0) record.leafIndex = index;
      }
      if (record.leafIndex !== null) {
        if (nextLeaves[record.leafIndex] !== commitment(privateNote(record))) throw new Error(`Tree commitment mismatch for note ${record.id}`);
        if (!terminal(record)) {
          record.status = known && approvedSet.has(record.label!) ? 'spendable'
            : !known && previousStatus === 'spendable' ? 'spendable' : 'inserted';
        }
      }
      const hash = nullifierHash(deriveNoteSecrets(seed, record.secretIndex).nullifier);
      if (spentSet.has(hash)) record.status = previousStatus === 'exited' ? 'exited' : 'spent';
    }
    await save(next);
    leaves = nextLeaves;
    approved = nextApproved;
    spent = nextSpent;
    approvalKnown = known;
  }
  async function poll<T>(check: () => Promise<T | undefined>, description: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await o.poll?.onPoll?.();
      const result = await check();
      if (result !== undefined) return result;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }
  async function settle(a: PaymentArgs): Promise<SettleReceipt> {
    if (a.payouts.length < 1 || a.payouts.length > 4) throw new Error('A payment requires one to four payouts');
    const payouts: PayoutRequest[] = a.payouts.map(p => {
      addressFromBech32(p.address, ctx.deployment.network);
      if (typeof p.amount !== 'bigint' || p.amount < 1_000_000n || p.amount >= 1n << 64n) throw new Error('Payout must meet the minimum of 1000000 lovelace and fit in 64 bits');
      const datumHash = p.datumHash ?? null;
      if (datumHash !== null && !/^[0-9a-f]{64}$/.test(datumHash)) throw new Error('Invalid payout datum hash');
      // A caller may attach local note data. Only the public payment fields may leave this process.
      return { address: p.address, amount: p.amount, datumHash };
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await sync();
      if (!approvalKnown) await poll(async () => { await sync(); return approvalKnown ? true : undefined; }, 'the approved list');
      const candidates = data.notes.filter(n => n.status === 'spendable').sort((a, b) => a.value! < b.value! ? -1 : a.value! > b.value! ? 1 : 0);
      const requested = a.noteId === undefined ? undefined : find(a.noteId);
      if (requested && requested.status !== 'spendable') throw new Error(`Note ${requested.id} is not spendable`);
      if (!requested && candidates.length === 0) throw new Error('No spendable note is available');
      const quote = await relayer.quote(payouts);
      const total = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
      if (quote.poolId !== ctx.deployment.poolId || quote.protocolFee < 0n || quote.relayerFee < 0n
        || quote.withdrawn !== total + quote.protocolFee + quote.relayerFee) throw new Error('Relayer quote does not match the payment');
      const record = requested ?? candidates.find(n => n.value! >= quote.withdrawn);
      if (!record || record.value! < quote.withdrawn) throw new Error('Amount plus fees exceeds the note value; no note can cover it');
      const intent: SettleIntent = { poolId: Buffer.from(quote.poolId, 'hex'), relayer: Buffer.from(quote.relayerKeyHash, 'hex'),
        validUntil: BigInt(quote.validUntil), payouts: payouts.map(p => ({ address: addressFromBech32(p.address, ctx.deployment.network),
          amount: p.amount, datumHash: p.datumHash === null ? null : Buffer.from(p.datumHash, 'hex') })) };
      const changeIndex = data.nextChangeIndex;
      const secretIndex = CHANGE_OFFSET + changeIndex;
      const secrets = deriveNoteSecrets(seed, secretIndex);
      const witness = spendWitness({ note: privateNote(record), stateTree: MerkleTree.fromLeaves(leaves), stateIndex: record.leafIndex!,
        aspTree: MerkleTree.fromLeaves(approved), aspIndex: approved.indexOf(record.label!), withdrawn: quote.withdrawn,
        newNullifier: secrets.nullifier, newSecret: secrets.secret, context: contextFor(intent) });
      const proof = await prove(o.artifacts.spend, witness.input);
      // Reserve each index before sending a proof, including attempts with uncertain responses.
      await save({ ...data, nextChangeIndex: changeIndex + 1 });
      let status: SettleStatus;
      try {
        status = await relayer.settle({ quoteId: quote.quoteId,
          proof: { a: hex(proof.cardano.a), b: hex(proof.cardano.b), c: hex(proof.cardano.c) },
          publicInputs: { newCommitment: witness.public.newCommitment, nullifierHash: witness.public.nullifierHash,
            withdrawn: quote.withdrawn, stateRoot: witness.public.stateRoot, aspRoot: witness.public.aspRoot, context: witness.public.context },
          intent: { poolId: quote.poolId, payouts, relayer: quote.relayerKeyHash, validUntil: quote.validUntil } });
      } catch (error) {
        if (attempt < 2 && error instanceof ApiError && ['stale_root', 'stale_asp_root', 'internal'].includes(error.code)) continue;
        throw error;
      }
      if (status.status === 'failed') throw new Error(`Settle ${status.id} failed: ${status.error ?? 'unknown error'}`);
      const next = structuredClone(data);
      next.notes.find(n => n.id === record.id)!.status = 'spent';
      let changeNoteId: string | null = null;
      if (witness.changeNote.value > 0n) {
        changeNoteId = `c${changeIndex}`;
        next.notes.push({ id: changeNoteId, kind: 'change', secretIndex, status: 'queued', value: witness.changeNote.value,
          label: record.label, leafIndex: null, origin: record.origin === null ? null : { ...record.origin }, gross: null,
          precommitment: precommitment(secrets.nullifier, secrets.secret) });
      }
      await save(next);
      return { id: status.id, txHash: status.txHash, noteId: record.id, changeNoteId, withdrawn: quote.withdrawn };
    }
    throw new Error('Private settlement exhausted its attempts');
  }
  function refundAddress(record: NoteRecord, refundSeed: Uint8Array): string {
    if (!record.origin) throw new Error('Note has no original deposit');
    if (hex(keyHash(refundSeed)) !== record.origin.refundKeyHash) throw new Error('Refund seed does not match the original refund key');
    return enterpriseAddress(refundSeed, ctx.deployment.network);
  }
  const sdk: ZbaseCardano = {
    prepareDeposit: a => exclusive(() => prepare(a)),
    deposit: a => exclusive(async () => {
      const refundKeyHash = hex(keyHash(a.walletSeed));
      const prepared = await prepare({ amount: a.amount, refundKeyHash });
      const tx = await buildDeposit(ctx, { payer: { address: enterpriseAddress(a.walletSeed, ctx.deployment.network) },
        amount: a.amount, precommitment: prepared.precommitment, refundKeyHash });
      const signed = signTx(tx.cbor, [a.walletSeed]);
      await ctx.provider.evaluate(signed);
      return { txId: await ctx.provider.submit(signed), prepared };
    }),
    sync: () => exclusive(sync),
    listNotes: () => structuredClone(current().notes),
    balance() {
      let spendable = 0n;
      let pending = 0n;
      for (const note of current().notes) {
        if (note.status === 'spendable') spendable += note.value ?? 0n;
        else if (['deposited', 'inserted', 'queued'].includes(note.status)) pending += note.value ?? note.gross ?? 0n;
      }
      return { spendable, pending };
    },
    waitForNote: id => poll(() => exclusive(async () => {
      await sync();
      const note = find(id);
      if (terminal(note)) throw new Error(`Note ${id} is ${note.status}`);
      return note.status === 'spendable' && approvalKnown ? structuredClone(note) : undefined;
    }), `note ${id}`),
    settlePrivately: a => exclusive(() => settle(a)),
    waitForSettle: id => poll(async () => {
      const status = await relayer.getSettle(id);
      if (status.status === 'failed') throw new Error(`Settle ${id} failed: ${status.error ?? 'unknown error'}`);
      return status.status === 'confirmed' ? status : undefined;
    }, `settle ${id}`),
    ragequit: a => exclusive(async () => {
      await sync();
      const record = find(a.noteId);
      if (terminal(record) || record.leafIndex === null) throw new Error(`Note ${record.id} cannot exit in status ${record.status}`);
      const address = refundAddress(record, a.refundSeed);
      const payTo = a.payTo ?? address;
      addressFromBech32(payTo, ctx.deployment.network);
      const witness = ragequitWitness({ note: privateNote(record), stateTree: MerkleTree.fromLeaves(leaves), stateIndex: record.leafIndex });
      const proof = await prove(o.artifacts.ragequit, witness.input);
      const trie = await nullifierInsertion(spent, witness.nullifierHash);
      const pool = await readPool(ctx);
      if (pool.datum.nullifierRoot !== trie.oldRoot) throw new Error('Nullifier tree changed; sync and retry the exit');
      const tx = await buildRagequit(ctx, { payer: { address }, pool, proof: proof.cardano, nullifierHash: witness.nullifierHash,
        value: record.value!, stateRoot: witness.stateRoot, depositRef: { txId: record.origin!.txId, index: record.origin!.index },
        refundKeyHash: record.origin!.refundKeyHash, nullifierProof: trie.proofCbor, newNullifierRoot: trie.newRoot, payTo });
      const signed = signTx(tx.cbor, [a.refundSeed]);
      await ctx.provider.evaluate(signed);
      const txId = await ctx.provider.submit(signed);
      await save({ ...data, notes: data.notes.map(n => n.id === record.id ? { ...n, status: 'exited' } : n) });
      return { txId };
    }),
    refund: a => exclusive(async () => {
      await sync();
      const record = find(a.noteId);
      if (record.kind !== 'deposit' || record.status !== 'deposited') throw new Error(`Note ${record.id} is not a pending deposit`);
      const address = refundAddress(record, a.refundSeed);
      const payTo = a.payTo ?? address;
      addressFromBech32(payTo, ctx.deployment.network);
      const deposit = (await readDeposits(ctx)).find(d => d.utxo.ref.txId === record.origin!.txId && d.utxo.ref.index === record.origin!.index);
      if (!deposit) throw new Error('Pending deposit UTXO is no longer available');
      const tx = await buildRefund(ctx, { payer: { address }, deposit, payTo });
      const signed = signTx(tx.cbor, [a.refundSeed]);
      await ctx.provider.evaluate(signed);
      const txId = await ctx.provider.submit(signed);
      await save({ ...data, notes: data.notes.map(n => n.id === record.id ? { ...n, status: 'refunded' } : n) });
      return { txId };
    }),
    x402Signer(a) {
      if (a?.mode !== undefined && a.mode !== 'stealth') throw new Error('Only stealth mode is supported');
      return stealthSigner({ seed, ctx, exclusive, settle, poll, index: () => current().nextOneTimeIndex,
        advance: () => save({ ...data, nextOneTimeIndex: data.nextOneTimeIndex + 1 }) });
    },
  };
  return sdk;
}
