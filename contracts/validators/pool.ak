use aiken/crypto.{ScriptHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use zx402/groth16.{VerificationKey}
use zx402/pool as rules
use zx402/pool/common.{PoolParams}
use zx402/types.{AssetClass, PoolDatum, PoolRedeemer}

validator pool(
  nft_policy: PolicyId,
  deposit_script: ScriptHash,
  asset: AssetClass,
  vk_spend: VerificationKey,
  vk_insert: VerificationKey,
  vk_ragequit: VerificationKey,
) {
  spend(
    datum: Option<PoolDatum>,
    redeemer: PoolRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    rules.validate(
      PoolParams {
        nft_policy,
        deposit_script,
        asset,
        vk_spend,
        vk_insert,
        vk_ragequit,
      },
      datum,
      redeemer,
      own_ref,
      self,
    )
  }

  else(_) {
    fail
  }
}
