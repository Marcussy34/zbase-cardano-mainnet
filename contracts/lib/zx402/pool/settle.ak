use aiken/builtin
use aiken/collection/list
use aiken/interval.{Finite}
use aiken/merkle_patricia_forestry as mpf
use cardano/assets
use cardano/transaction.{InlineDatum, NoDatum, Output}
use zx402/constants
use zx402/encoding
use zx402/groth16.{Proof, VerificationKey}
use zx402/pool/common.{PoolContext}
use zx402/types.{AssetClass, Payout, PoolDatum, SettleIntent}

/// Bind the payment, accounting, and nullifier transition to one spend proof.
pub fn validate(
  ctx: PoolContext,
  vk: VerificationKey,
  proof: Proof,
  nullifier_hash: Int,
  new_commitment: Int,
  withdrawn: Int,
  state_root: Int,
  intent: SettleIntent,
  nullifier_proof: mpf.Proof,
) -> Bool {
  expect and {
      common.no_deposit_inputs(ctx),
      list.has(ctx.datum.roots, state_root),
      withdrawn > 0,
      withdrawn <= constants.max_value,
      new_commitment != 0,
      intent.pool_id == ctx.pool_id,
      !list.is_empty(intent.payouts),
      list.length(intent.payouts) <= constants.max_payouts,
      list.length(ctx.datum.queue) < constants.queue_max,
    }
  expect Finite(upper) = ctx.tx.validity_range.upper_bound.bound_type
  expect upper <= intent.valid_until
  expect
    when intent.relayer is {
      None -> True
      Some(key) -> common.signed_by(ctx.tx, key)
    }
  let asp_root = common.asp_root(ctx)
  expect [_continuing, ..outputs] = ctx.tx.outputs
  let paid = check_payouts(intent.payouts, outputs, ctx.asset)
  let fee = paid * ctx.config.settle_fee_bps / constants.bps_denominator
  expect paid + fee <= withdrawn
  expect ctx.balance_out == ctx.balance_in - ( withdrawn - fee )
  let context = encoding.context(intent)
  let nullifier_root = common.nullifier_insert(
    ctx.datum.nullifier_root,
    nullifier_hash,
    nullifier_proof,
  )
  expect
    ctx.out_datum == PoolDatum {
      ..ctx.datum,
      queue: list.concat(ctx.datum.queue, [new_commitment]),
      nullifier_root,
      fees_accrued: ctx.datum.fees_accrued + fee,
    }
  // All transaction checks precede the expensive curve operations.
  groth16.verify(
    vk,
    proof,
    [new_commitment, nullifier_hash, withdrawn, state_root, asp_root, context],
  )
}

fn check_payouts(
  payouts: List<Payout>,
  outputs: List<Output>,
  asset: AssetClass,
) -> Int {
  when payouts is {
    [] -> 0
    [payout, ..rest] -> {
      expect [output, ..outputs] = outputs
      expect and {
          output.address == payout.address,
          output.reference_script == None,
          if asset.policy == "" && asset.name == "" {
            output.value == assets.from_lovelace(payout.amount)
          } else {
            and {
              common.asset_amount(asset, output.value) == payout.amount,
              list.all(
                assets.flatten(output.value),
                fn(entry) {
                  let (policy, name, _) = entry
                  policy == "" && name == "" || policy == asset.policy && name == asset.name
                },
              ),
            }
          },
          when payout.datum_hash is {
            None -> output.datum == NoDatum
            Some(hash) -> {
              expect InlineDatum(datum) = output.datum
              builtin.blake2b_256(builtin.serialise_data(datum)) == hash
            }
          },
        }
      payout.amount + check_payouts(rest, outputs, asset)
    }
  }
}
