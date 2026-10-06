//// Pool test fixtures only. No helper here enforces validator rules.

use aiken/crypto.{ScriptHash}
use aiken/interval
use aiken/merkle_patricia_forestry as mpf
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use zbase/constants
use zbase/groth16
use zbase/pool/common.{PoolParams}
use zbase/testkit
use zbase/types.{AspDatum, AssetClass, ConfigDatum, PoolDatum}

/// The policy that identifies all three test NFTs.
pub const nft_policy: PolicyId = testkit.nft_policy

/// The payment script for test deposit inputs.
pub const deposit_script: ScriptHash = testkit.script_hash_2

/// The payment script for the test pool.
pub const pool_script: ScriptHash = testkit.script_hash_1

/// The pool address has no stake credential.
pub const pool_address: Address =
  Address { payment_credential: Script(pool_script), stake_credential: None }

/// The config address has a distinct payment script.
pub const config_address: Address =
  Address {
    payment_credential: Script(
      #"88888888888888888888888888888888888888888888888888888888",
    ),
    stake_credential: None,
  }

/// The ASP address has a distinct payment script.
pub const asp_address: Address =
  Address {
    payment_credential: Script(
      #"99999999999999999999999999999999999999999999999999999999",
    ),
    stake_credential: None,
  }

/// The treasury is a fixed key address.
pub const treasury_address: Address =
  Address {
    payment_credential: VerificationKey(testkit.key_hash_4),
    stake_credential: None,
  }

/// The spent pool reference used by every standard pool fixture.
pub const pool_ref: OutputReference = testkit.output_reference_1

/// A deliberately unusable key for paths that never verify proofs.
pub const placeholder_key: groth16.VerificationKey =
  groth16.VerificationKey { alpha: "", beta: "", gamma: "", delta: "", ic: [] }

/// Build ADA pool parameters with caller-supplied verification keys.
pub fn params(
  vk_spend: groth16.VerificationKey,
  vk_insert: groth16.VerificationKey,
  vk_ragequit: groth16.VerificationKey,
) -> PoolParams {
  PoolParams {
    nft_policy,
    deposit_script,
    asset: AssetClass { policy: "", name: "" },
    vk_spend,
    vk_insert,
    vk_ragequit,
  }
}

/// Use the M0 amounts and fees from SPEC 6.2, with two of three sample admins.
pub fn m0_config() -> ConfigDatum {
  ConfigDatum {
    admins: [testkit.key_hash_1, testkit.key_hash_2, testkit.key_hash_3],
    admin_threshold: 2,
    treasury: treasury_address,
    deposits_paused: False,
    min_deposit: 5_000_000,
    max_deposit: 50_000_000,
    pool_cap: 500_000_000,
    deposit_fee_bps: 0,
    settle_fee_bps: 0,
    crank_fee: 300_000,
  }
}

/// Build an inline pool output holding ADA and exactly one pool NFT.
pub fn pool_output(datum: PoolDatum, lovelace: Int) -> Output {
  testkit.output(
    pool_address,
    assets.from_lovelace(lovelace)
      |> assets.add(nft_policy, constants.pool_nft_name, 1),
    datum,
  )
}

/// Attach the standard spent reference to a pool output.
pub fn pool_input(datum: PoolDatum, lovelace: Int) -> Input {
  testkit.input(pool_ref, pool_output(datum, lovelace))
}

/// Build a config reference input with its authentic NFT and inline datum.
pub fn config_ref(config: ConfigDatum) -> Input {
  testkit.input(
    testkit.output_reference_2,
    testkit.output(
      config_address,
      assets.from_lovelace(2_000_000)
        |> assets.add(nft_policy, constants.config_nft_name, 1),
      config,
    ),
  )
}

/// Build an ASP reference input with its authentic NFT and inline root.
pub fn asp_ref(root: Int) -> Input {
  testkit.input(
    testkit.output_reference_3,
    testkit.output(
      asp_address,
      assets.from_lovelace(2_000_000)
        |> assets.add(nft_policy, constants.asp_nft_name, 1),
      AspDatum { root, operators: [testkit.key_hash_1], threshold: 1, uri: "" },
    ),
  )
}

/// Use the fixed Z[32] vector and the trie library's empty root for genesis.
pub fn genesis_datum() -> PoolDatum {
  PoolDatum {
    roots: [
      34147729537948564452788589313828361831422685361580832702235439851958634889397,
    ],
    size: 0,
    queue: [],
    nullifier_root: mpf.root(mpf.empty),
    fees_accrued: 0,
  }
}

/// Start CollectFees tests with five ADA of accrued fees.
pub fn fees_datum() -> PoolDatum {
  PoolDatum { ..genesis_datum(), fees_accrued: 5_000_000 }
}

/// Reduce only accrued fees in the expected continuing datum.
pub fn collected_datum(amount: Int) -> PoolDatum {
  PoolDatum { ..fees_datum(), fees_accrued: 5_000_000 - amount }
}

/// Build a passing CollectFees context for an amount from one to five ADA.
pub fn collect_fees_transaction(amount: Int) -> Transaction {
  testkit.transaction(
    [pool_input(fees_datum(), 25_000_000)],
    [config_ref(m0_config())],
    [
      pool_output(collected_datum(amount), 25_000_000 - amount),
      testkit.output(treasury_address, assets.from_lovelace(amount), Void),
    ],
    assets.zero,
    [],
    interval.everything,
  )
}

/// Replace only output zero's inline pool datum for a negative test.
pub fn with_out_datum(tx: Transaction, datum: PoolDatum) -> Transaction {
  expect [output, ..outputs] = tx.outputs
  Transaction {
    ..tx,
    outputs: [Output { ..output, datum: InlineDatum(datum) }, ..outputs],
  }
}
