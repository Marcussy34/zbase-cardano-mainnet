use zbase/groth16.{Proof, VerificationKey}
use zbase/pool/common.{PoolContext}

pub fn validate(
  _ctx: PoolContext,
  _vk: VerificationKey,
  _proof: Proof,
  _flush: Int,
) -> Bool {
  fail @"insert: not implemented"
}
