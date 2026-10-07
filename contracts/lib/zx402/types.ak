use aiken/crypto.{VerificationKeyHash}
use aiken/merkle_patricia_forestry as mpf
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{OutputReference}
use zx402/groth16.{Proof}

// Field and constructor order is the wire format in SPEC 4.5 and 6.3.
pub type Payout {
  address: Address,
  amount: Int,
  datum_hash: Option<ByteArray>,
}

pub type SettleIntent {
  pool_id: ByteArray,
  payouts: List<Payout>,
  relayer: Option<VerificationKeyHash>,
  valid_until: Int,
}

pub type PoolDatum {
  roots: List<Int>,
  size: Int,
  queue: List<Int>,
  nullifier_root: ByteArray,
  fees_accrued: Int,
}

pub type PoolRedeemer {
  Insert { proof: Proof, flush: Int }
  Settle {
    proof: Proof,
    nullifier_hash: Int,
    new_commitment: Int,
    withdrawn: Int,
    state_root: Int,
    intent: SettleIntent,
    nullifier_proof: mpf.Proof,
  }
  Ragequit {
    proof: Proof,
    nullifier_hash: Int,
    value: Int,
    state_root: Int,
    deposit_ref: OutputReference,
    refund: VerificationKeyHash,
    nullifier_proof: mpf.Proof,
  }
  CollectFees { amount: Int }
}

pub type DepositDatum {
  precommitment: Int,
  refund: VerificationKeyHash,
}

pub type DepositRedeemer {
  Absorb
  Refund
}

pub type ConfigDatum {
  admins: List<VerificationKeyHash>,
  admin_threshold: Int,
  treasury: Address,
  deposits_paused: Bool,
  min_deposit: Int,
  max_deposit: Int,
  pool_cap: Int,
  deposit_fee_bps: Int,
  settle_fee_bps: Int,
  crank_fee: Int,
}

pub type AspDatum {
  root: Int,
  operators: List<VerificationKeyHash>,
  threshold: Int,
  uri: ByteArray,
}

/// ADA uses an empty policy and an empty name.
pub type AssetClass {
  policy: PolicyId,
  name: AssetName,
}
