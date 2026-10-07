use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/merkle_patricia_forestry as mpf
use cardano/address.{Script}
use cardano/assets.{Assets as Value, PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}
use zx402/constants
use zx402/encoding
use zx402/groth16.{VerificationKey, in_field}
use zx402/types.{AspDatum, AssetClass, ConfigDatum, PoolDatum}

pub type PoolParams {
  nft_policy: PolicyId,
  deposit_script: ScriptHash,
  asset: AssetClass,
  vk_spend: VerificationKey,
  vk_insert: VerificationKey,
  vk_ragequit: VerificationKey,
}

/// Everything a rule needs, read once from the transaction.
pub type PoolContext {
  pool_id: ByteArray,
  deposit_script: ScriptHash,
  asset: AssetClass,
  datum: PoolDatum,
  out_datum: PoolDatum,
  balance_in: Int,
  balance_out: Int,
  config: ConfigDatum,
  tx: Transaction,
}

/// Enforce P1, P2, P3 and P5, and parse the continuing inline datum for P4.
pub fn load(
  params: PoolParams,
  datum: Option<PoolDatum>,
  own_ref: OutputReference,
  tx: Transaction,
) -> PoolContext {
  expect Some(datum) = datum
  let own = transaction.resolve_input(tx.inputs, own_ref)
  expect
    assets.quantity_of(own.value, params.nft_policy, constants.pool_nft_name) == 1
  expect [continuing, ..] = tx.outputs
  expect continuing.address == own.address
  expect
    assets.quantity_of(
      continuing.value,
      params.nft_policy,
      constants.pool_nft_name,
    ) == 1
  expect continuing.reference_script == None
  // Inspect names as well as policies, including other tokens under the NFT policy.
  expect
    list.all(
      assets.flatten(continuing.value),
      fn(entry) {
        let (policy, name, _) = entry
        or {
          policy == "" && name == "",
          policy == params.nft_policy && name == constants.pool_nft_name,
          policy == params.asset.policy && name == params.asset.name,
        }
      },
    )
  expect InlineDatum(raw_out) = continuing.datum
  expect out_datum: PoolDatum = raw_out
  expect Some(config_input) = list.find(
    tx.reference_inputs,
    fn(input) {
      assets.quantity_of(
        input.output.value,
        params.nft_policy,
        constants.config_nft_name,
      ) == 1
    },
  )
  expect InlineDatum(raw_config) = config_input.output.datum
  expect config: ConfigDatum = raw_config
  PoolContext {
    pool_id: params.nft_policy,
    deposit_script: params.deposit_script,
    asset: params.asset,
    datum,
    out_datum,
    balance_in: asset_amount(params.asset, own.value),
    balance_out: asset_amount(params.asset, continuing.value),
    config,
    tx,
  }
}

/// Return the pool asset quantity; ADA uses the empty policy and name.
pub fn asset_amount(asset: AssetClass, value: Value) -> Int {
  assets.quantity_of(value, asset.policy, asset.name)
}

/// Select deposit payment credentials without changing transaction input order.
pub fn deposit_inputs(ctx: PoolContext) -> List<Input> {
  list.filter(
    ctx.tx.inputs,
    fn(input) {
      input.output.address.payment_credential == Script(ctx.deposit_script)
    },
  )
}

/// Enforce S1, R1 and C1, including deposit addresses with a stake credential.
pub fn no_deposit_inputs(ctx: PoolContext) -> Bool {
  list.is_empty(deposit_inputs(ctx))
}

/// Read S3's root only from an inline datum authenticated by the ASP NFT.
pub fn asp_root(ctx: PoolContext) -> Int {
  expect Some(input) = list.find(
    ctx.tx.reference_inputs,
    fn(input) {
      assets.quantity_of(
        input.output.value,
        ctx.pool_id,
        constants.asp_nft_name,
      ) == 1
    },
  )
  expect InlineDatum(raw) = input.output.datum
  expect datum: AspDatum = raw
  datum.root
}

/// Enforce a canonical nullifier and authenticated absence before S8 or R6 adds it.
pub fn nullifier_insert(
  root: ByteArray,
  nullifier_hash: Int,
  proof: mpf.Proof,
) -> ByteArray {
  expect in_field(nullifier_hash)
  root
    |> mpf.from_root
    |> mpf.insert(encoding.nullifier_key(nullifier_hash), #"01", proof)
    |> mpf.root
}

/// Check whether the required key hash appears among the transaction signers.
pub fn signed_by(tx: Transaction, key: VerificationKeyHash) -> Bool {
  list.has(tx.extra_signatories, key)
}
