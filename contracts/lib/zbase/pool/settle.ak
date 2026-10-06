use aiken/merkle_patricia_forestry as mpf
use zbase/groth16.{Proof, VerificationKey}
use zbase/pool/common.{PoolContext}
use zbase/types.{SettleIntent}

pub fn validate(
  _ctx: PoolContext,
  _vk: VerificationKey,
  _proof: Proof,
  _nullifier_hash: Int,
  _new_commitment: Int,
  _withdrawn: Int,
  _state_root: Int,
  _intent: SettleIntent,
  _nullifier_proof: mpf.Proof,
) -> Bool {
  fail @"settle: not implemented"
}
