use cardano/transaction.{OutputReference, Transaction}
use zx402/pool/common.{PoolParams}
use zx402/pool/fees
use zx402/pool/insert
use zx402/pool/ragequit
use zx402/pool/settle
use zx402/types.{CollectFees, Insert, PoolDatum, PoolRedeemer, Ragequit, Settle}

/// Validate a pool spend as a plain function for library tests.
pub fn validate(
  params: PoolParams,
  datum: Option<PoolDatum>,
  redeemer: PoolRedeemer,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  let ctx = common.load(params, datum, own_ref, tx)
  when redeemer is {
    Insert { proof, flush } ->
      insert.validate(ctx, params.vk_insert, proof, flush)
    Settle {
      proof,
      nullifier_hash,
      new_commitment,
      withdrawn,
      state_root,
      intent,
      nullifier_proof,
    } ->
      settle.validate(
        ctx,
        params.vk_spend,
        proof,
        nullifier_hash,
        new_commitment,
        withdrawn,
        state_root,
        intent,
        nullifier_proof,
      )
    Ragequit {
      proof,
      nullifier_hash,
      value,
      state_root,
      deposit_ref,
      refund,
      nullifier_proof,
    } ->
      ragequit.validate(
        ctx,
        params.vk_ragequit,
        proof,
        nullifier_hash,
        value,
        state_root,
        deposit_ref,
        refund,
        nullifier_proof,
      )
    CollectFees { amount } -> fees.validate(ctx, amount)
  }
}
