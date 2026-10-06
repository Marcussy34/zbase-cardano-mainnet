import type { IndexerApi } from '@zbase-cardano/api';
import { MerkleTree, insertWitness } from '@zbase-cardano/crypto';
import { prove, type CircuitArtifacts } from '@zbase-cardano/prover';
import {
  buildInsert, enterpriseAddress, planInsert, readConfig, readDeposits, readPool, signTx,
  type ChainContext,
} from '@zbase-cardano/txlib';

export class Crank {
  private readonly ctx: ChainContext;
  private readonly indexer: IndexerApi;
  private readonly seed: Uint8Array;
  private readonly artifacts: CircuitArtifacts;

  constructor(a: { ctx: ChainContext; indexer: IndexerApi; seed: Uint8Array; artifacts: CircuitArtifacts }) {
    this.ctx = a.ctx;
    this.indexer = a.indexer;
    this.seed = a.seed.slice();
    this.artifacts = a.artifacts;
  }

  /** One round. A stale indexer cannot supply a witness for the current pool. */
  async tick(): Promise<{ txId: string; notes: number; deposits: number } | null> {
    const [pool, config, deposits] = await Promise.all([
      readPool(this.ctx), readConfig(this.ctx), readDeposits(this.ctx),
    ]);
    const leaves: bigint[] = [];
    do {
      const page = await this.indexer.getLeaves(leaves.length, 1000);
      if (page.from !== leaves.length || page.size !== pool.datum.size || page.root !== pool.datum.roots[0]
        || page.leaves.length > page.size - leaves.length) return null;
      if (page.leaves.length === 0 && leaves.length < page.size) return null;
      leaves.push(...page.leaves);
    } while (leaves.length < pool.datum.size);
    const tree = MerkleTree.fromLeaves(leaves);
    if (tree.size !== pool.datum.size || tree.root !== pool.datum.roots[0]) return null;
    const plan = planInsert({ poolId: this.ctx.deployment.poolId, pool, config: config.datum, deposits });
    if (plan === null) return null;
    const witness = insertWitness({ tree, slots: plan.slots });
    const proof = await prove(this.artifacts, witness.input);
    const tx = await buildInsert(this.ctx, {
      payer: { address: enterpriseAddress(this.seed, this.ctx.deployment.network) },
      pool, plan, proof: proof.cardano, newRoot: witness.newRoot,
    });
    const txId = await this.ctx.provider.submit(signTx(tx.cbor, [this.seed]));
    return { txId, notes: plan.flush, deposits: plan.deposits.length };
  }
}
