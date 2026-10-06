use cardano/address
use cardano/assets
use cardano/transaction.{Input, Output, Transaction}
use zbase/pool
use zbase/pool/common.{PoolParams}
use zbase/pool/kit
use zbase/testkit
use zbase/types.{AssetClass, CollectFees, DepositDatum, PoolDatum}

fn validate(tx: Transaction, amount: Int) -> Bool {
  pool.validate(
    kit.params(kit.placeholder_key, kit.placeholder_key, kit.placeholder_key),
    Some(kit.fees_datum()),
    CollectFees { amount },
    kit.pool_ref,
    tx,
  )
}

test pool_c0_collect_part() {
  validate(kit.collect_fees_transaction(2_000_000), 2_000_000)
}

test pool_c0_collect_all() {
  validate(kit.collect_fees_transaction(5_000_000), 5_000_000)
}

test pool_c1_dep_03_deposit_input() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  let deposit = testkit.input(
    testkit.output_reference_2,
    testkit.output(
      address.from_script(kit.deposit_script),
      assets.from_lovelace(5_000_000),
      DepositDatum { precommitment: 42, refund: testkit.key_hash_1 },
    ),
  )
  expect
    validate(
      Transaction { ..base, inputs: [deposit, ..base.inputs] },
      2_000_000,
    )
  True
}

test pool_c2_zero_amount() fail {
  expect validate(kit.collect_fees_transaction(2_000_000), 0)
  True
}

test pool_c2_above_accrued() fail {
  expect validate(kit.collect_fees_transaction(2_000_000), 5_000_001)
  True
}

test pool_c2_negative_amount() fail {
  expect validate(kit.collect_fees_transaction(2_000_000), -1)
  True
}

test pool_c3_missing_treasury_output() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, _treasury] = base.outputs
  expect validate(Transaction { ..base, outputs: [continuing] }, 2_000_000)
  True
}

test pool_c3_treasury_one_less() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let treasury = Output { ..treasury, value: assets.from_lovelace(1_999_999) }
  expect
    validate(Transaction { ..base, outputs: [continuing, treasury] }, 2_000_000)
  True
}

test pool_c3_wrong_treasury_address() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let treasury = Output {
    ..treasury,
    address: address.from_verification_key(testkit.key_hash_1),
  }
  expect
    validate(Transaction { ..base, outputs: [continuing, treasury] }, 2_000_000)
  True
}

test pool_c4_balance_falls_one_more() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let continuing = Output {
    ..continuing,
    value: assets.add(continuing.value, "", "", -1),
  }
  expect
    validate(Transaction { ..base, outputs: [continuing, treasury] }, 2_000_000)
  True
}

test pool_c4_balance_falls_one_less() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let continuing = Output {
    ..continuing,
    value: assets.add(continuing.value, "", "", 1),
  }
  expect
    validate(Transaction { ..base, outputs: [continuing, treasury] }, 2_000_000)
  True
}

test pool_c4_fees_fall_one_less() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  let datum = kit.fees_datum()
  expect
    validate(
      kit.with_out_datum(base, PoolDatum { ..datum, fees_accrued: 3_000_001 }),
      2_000_000,
    )
  True
}

test pool_c4_fees_unchanged() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect validate(kit.with_out_datum(base, kit.fees_datum()), 2_000_000)
  True
}

test pool_c0_token_pool_counts_asset_not_lovelace() {
  let base = kit.collect_fees_transaction(2_000_000)
  let asset = AssetClass { policy: testkit.script_hash_1, name: "token" }
  let params = kit.params(
    kit.placeholder_key,
    kit.placeholder_key,
    kit.placeholder_key,
  )
  expect [own] = base.inputs
  expect [continuing, treasury] = base.outputs
  let output = Output {
    ..own.output,
    value: assets.add(own.output.value, asset.policy, asset.name, 5_000_000),
  }
  let continuing = Output {
    ..continuing,
    value: continuing.value
      |> assets.add("", "", 2_000_000)
      |> assets.add(asset.policy, asset.name, 3_000_000),
  }
  let treasury = Output {
    ..treasury,
    value: assets.add(treasury.value, asset.policy, asset.name, 2_000_000),
  }
  let tx = Transaction {
    ..base,
    inputs: [Input { ..own, output }],
    outputs: [continuing, treasury],
  }
  pool.validate(
    PoolParams { ..params, asset },
    Some(kit.fees_datum()),
    CollectFees { amount: 2_000_000 },
    kit.pool_ref,
    tx,
  )
}

test pool_c3_treasury_may_receive_more() {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let treasury = Output { ..treasury, value: assets.from_lovelace(2_000_001) }
  validate(Transaction { ..base, outputs: [continuing, treasury] }, 2_000_000)
}

test pool_c2_zero_with_matching_accounting() fail {
  expect validate(kit.collect_fees_transaction(0), 0)
  True
}

test pool_c2_above_accrued_with_matching_accounting() fail {
  expect validate(kit.collect_fees_transaction(5_000_001), 5_000_001)
  True
}
