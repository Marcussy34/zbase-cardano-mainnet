use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/merkle_patricia_forestry as mpf
use cardano/transaction.{OutputReference}
use zbase/constants
use zbase/encoding
use zbase/groth16.{Proof, VerificationKey}
use zbase/pool/common.{PoolContext}
use zbase/types.{PoolDatum}

/// The deposit label and signer authorize a full exit without ASP approval.
pub fn validate(
  ctx: PoolContext,
  vk: VerificationKey,
  proof: Proof,
  nullifier_hash: Int,
  value: Int,
  state_root: Int,
  deposit_ref: OutputReference,
  refund: VerificationKeyHash,
  nullifier_proof: mpf.Proof,
) -> Bool {
  expect and {
      common.no_deposit_inputs(ctx),
      list.has(ctx.datum.roots, state_root),
      common.signed_by(ctx.tx, refund),
      value > 0,
      value <= constants.max_value,
      ctx.balance_out == ctx.balance_in - value,
    }
  let label = encoding.label(ctx.pool_id, deposit_ref, refund)
  expect label != 0
  let nullifier_root = common.nullifier_insert(
    ctx.datum.nullifier_root,
    nullifier_hash,
    nullifier_proof,
  )
  // Reject invalid state transitions before paying for the pairing check.
  and {
    ctx.out_datum == PoolDatum { ..ctx.datum, nullifier_root },
    groth16.verify(vk, proof, [nullifier_hash, state_root, value, label]),
  }
}
