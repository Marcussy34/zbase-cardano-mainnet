use aiken/crypto.{VerificationKeyHash}
use aiken/merkle_patricia_forestry as mpf
use cardano/transaction.{OutputReference}
use zbase/groth16.{Proof, VerificationKey}
use zbase/pool/common.{PoolContext}

pub fn validate(
  _ctx: PoolContext,
  _vk: VerificationKey,
  _proof: Proof,
  _nullifier_hash: Int,
  _value: Int,
  _state_root: Int,
  _deposit_ref: OutputReference,
  _refund: VerificationKeyHash,
  _nullifier_proof: mpf.Proof,
) -> Bool {
  fail @"ragequit: not implemented"
}
