use aiken/collection/list
use zx402/pool/common.{PoolContext}
use zx402/types.{PoolDatum}

/// Collect fees only when a separate output pays the configured treasury.
pub fn validate(ctx: PoolContext, amount: Int) -> Bool {
  expect [_continuing, ..outputs] = ctx.tx.outputs
  and {
    common.no_deposit_inputs(ctx),
    amount > 0,
    amount <= ctx.datum.fees_accrued,
    list.any(
      outputs,
      fn(output) {
        output.address == ctx.config.treasury && common.asset_amount(
          ctx.asset,
          output.value,
        ) >= amount
      },
    ),
    ctx.balance_out == ctx.balance_in - amount,
    ctx.out_datum == PoolDatum {
      ..ctx.datum,
      fees_accrued: ctx.datum.fees_accrued - amount,
    },
  }
}
