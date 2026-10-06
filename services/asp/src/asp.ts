import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { DepositView, IndexerApi } from '@zbase-cardano/api';
import { MerkleTree, assertCanonical } from '@zbase-cardano/crypto';
import { buildAspUpdate, decodeTx, enterpriseAddress, keyHash, readAsp, signTx, type ChainContext } from '@zbase-cardano/txlib';

interface Options {
  ctx: ChainContext;
  indexer: IndexerApi;
  payerSeed: Uint8Array;
  operatorSeeds: Uint8Array[];
  deny?: (deposit: DepositView) => boolean;
  storePath?: string;
}
interface TickResult { approved: number; txId: string | null }
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function readLabels(value: unknown): bigint[] {
  if (!Array.isArray(value)) throw new Error('Invalid ASP store label list');
  return value.map(label => {
    if (typeof label !== 'string' || !/^(0|[1-9][0-9]*)$/.test(label)) throw new Error('Invalid ASP store label');
    return assertCanonical(BigInt(label), 'ASP label');
  });
}

/** Approval order is stable. Removal tombstones prevent automatic reapproval after restart. */
export class AspService {
  private readonly options: Options;
  private approved: bigint[] = [];
  private removed = new Set<bigint>();
  private ticking?: Promise<TickResult>;
  private pending?: { txId: string; input: string };

  constructor(a: Options) {
    this.options = a;
    if (a.storePath && existsSync(a.storePath)) {
      const stored = JSON.parse(readFileSync(a.storePath, 'utf8')) as Record<string, unknown>;
      if (stored.version !== 1 || stored.poolId !== a.ctx.deployment.poolId) throw new Error('ASP store belongs to another pool or version');
      this.approved = readLabels(stored.leaves);
      this.removed = new Set(readLabels(stored.removed));
      const active = this.approved.filter(label => label !== 0n);
      if (new Set(active).size !== active.length || active.some(label => this.removed.has(label))) throw new Error('Inconsistent ASP store labels');
    }
  }

  leaves(): bigint[] { return [...this.approved]; }

  remove(label: bigint): void {
    assertCanonical(label, 'ASP label');
    if (label === 0n) throw new RangeError('Cannot remove the empty ASP leaf');
    const leaves = this.approved.map(leaf => leaf === label ? 0n : leaf);
    const removed = new Set(this.removed).add(label);
    this.persist(leaves, removed);
    this.approved = leaves;
    this.removed = removed;
  }

  tick(): Promise<TickResult> {
    if (this.ticking) return this.ticking;
    this.ticking = this.update().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private persist(leaves: bigint[], removed: Set<bigint>): void {
    const { storePath, ctx } = this.options;
    if (!storePath) return;
    const temporary = `${storePath}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, poolId: ctx.deployment.poolId,
        leaves: leaves.map(String), removed: [...removed].map(String) }) + '\n', { mode: 0o600 });
      // Rename publishes the whole list, so a restart cannot observe half a JSON document.
      renameSync(temporary, storePath);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private async update(): Promise<TickResult> {
    const { ctx, indexer, payerSeed, operatorSeeds, deny } = this.options;
    const deposits = (await indexer.getDeposits()).filter(d => d.status === 'absorbed')
      .sort((a, b) => (a.leafIndex ?? Number.MAX_SAFE_INTEGER) - (b.leafIndex ?? Number.MAX_SAFE_INTEGER));
    const leaves = [...this.approved];
    const known = new Set(leaves);
    let approved = 0;
    for (const deposit of deposits) {
      const label = deposit.label;
      if (label === null || label === 0n || known.has(label) || this.removed.has(label) || deny?.(deposit)) continue;
      assertCanonical(label, 'ASP label');
      leaves.push(label);
      known.add(label);
      approved += 1;
    }
    if (approved > 0) {
      this.persist(leaves, this.removed);
      this.approved = leaves;
    }
    const current = await readAsp(ctx);
    const input = `${current.utxo.ref.txId}#${current.utxo.ref.index}`;
    // Reads return confirmed UTXOs. Wait for this input to change before posting again.
    if (this.pending?.input === input) return { approved, txId: null };
    this.pending = undefined;
    const root = MerkleTree.fromLeaves(this.approved).root;
    if (root === current.datum.root) return { approved, txId: null };
    const signers = [...new Set(operatorSeeds.map(seed => hex(keyHash(seed))))];
    if (signers.filter(signer => current.datum.operators.includes(signer)).length < current.datum.threshold) {
      throw new Error('Operator signatures do not satisfy the ASP threshold');
    }
    const tx = await buildAspUpdate(ctx, { root, signers,
      payer: { address: enterpriseAddress(payerSeed, ctx.deployment.network) } });
    if (!decodeTx(tx.cbor).inputs.some(ref => `${ref.txId}#${ref.index}` === input)) throw new Error('ASP state changed while building the update');
    const signed = signTx(tx.cbor, [payerSeed, ...operatorSeeds]);
    await ctx.provider.evaluate(signed);
    const txId = await ctx.provider.submit(signed);
    this.pending = { txId, input };
    return { approved, txId };
  }
}
