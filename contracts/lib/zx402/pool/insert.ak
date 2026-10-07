use aiken/collection/list
use cardano/transaction.{InlineDatum}
use zx402/constants
use zx402/encoding
use zx402/groth16.{Proof, VerificationKey}
use zx402/pool/common.{PoolContext}
use zx402/types.{DepositDatum, PoolDatum}

pub fn validate(
  ctx: PoolContext,
  vk: VerificationKey,
  proof: Proof,
  flush: Int,
) -> Bool {
  let deposits = common.deposit_inputs(ctx)
  let count = list.length(deposits)
  let used = flush + count
  expect flush >= 0
  expect used >= 1 && used <= constants.insert_batch
  expect flush <= list.length(ctx.datum.queue)
  expect count == 0 || !ctx.config.deposits_paused

  // The cranker takes ADA separately from a token deposit's credited value.
  let crank_fee = if ctx.asset.policy == "" && ctx.asset.name == "" {
    ctx.config.crank_fee
  } else {
    0
  }
  let empty_slots = list.repeat(0, 3 * ( constants.insert_batch - used ))
  let (deposit_slots, fees, growth) = list.foldr(
    deposits,
    (empty_slots, 0, 0),
    fn(input, acc) {
      expect InlineDatum(raw) = input.output.datum
      expect datum: DepositDatum = raw
      expect datum.precommitment > 0 && groth16.in_field(datum.precommitment)
      let gross = common.asset_amount(ctx.asset, input.output.value)
      expect gross >= ctx.config.min_deposit && gross <= ctx.config.max_deposit
      let fee = gross * ctx.config.deposit_fee_bps / constants.bps_denominator
      let value = gross - fee - crank_fee
      expect value > 0
      let label = encoding.label(
        ctx.pool_id,
        input.output_reference,
        datum.refund,
      )
      expect label != 0
      let (slots, fees, growth) = acc
      // Prepending in a right fold preserves transaction input order.
      (
        [value, label, datum.precommitment, ..slots],
        fees + fee,
        growth + value + fee,
      )
    },
  )
  let slots = list.foldr(
    list.take(ctx.datum.queue, flush),
    deposit_slots,
    fn(commitment, slots) { [0, 0, commitment, ..slots] },
  )
  expect [old_root, ..] = ctx.datum.roots
  expect [new_root, ..] = ctx.out_datum.roots
  let new_fees = ctx.datum.fees_accrued + fees
  // Reject state and balance mismatches before paying for curve operations.
  and {
    ctx.out_datum == PoolDatum {
      ..ctx.datum,
      roots: list.take([new_root, ..ctx.datum.roots], constants.root_history),
      size: ctx.datum.size + used,
      queue: list.drop(ctx.datum.queue, flush),
      fees_accrued: new_fees,
    },
    ctx.balance_out == ctx.balance_in + growth,
    count == 0 || ctx.balance_out - new_fees <= ctx.config.pool_cap,
    groth16.verify(vk, proof, [old_root, new_root, ctx.datum.size, ..slots]),
  }
}
