use aiken/collection/list
use aiken/interval
use cardano/address
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, Output, OutputReference, Transaction}
use zx402/constants
use zx402/testkit
use zx402/types.{Absorb, DepositDatum, DepositRedeemer, Refund}

validator deposit(nft_policy: PolicyId) {
  spend(
    datum: Option<DepositDatum>,
    redeemer: DepositRedeemer,
    _own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(old) = datum
    when redeemer is {
      Absorb ->
        // The pool validator enforces Insert for every absorbed deposit.
        list.any(
          self.inputs,
          fn(input) {
            assets.quantity_of(
              input.output.value,
              nft_policy,
              constants.pool_nft_name,
            ) == 1
          },
        )
      Refund -> list.has(self.extra_signatories, old.refund)
    }
  }

  else(_) {
    fail
  }
}

fn deposit_datum() -> DepositDatum {
  DepositDatum { precommitment: 42, refund: testkit.key_hash_1 }
}

fn absorb_transaction() -> Transaction {
  let pool = testkit.input(
    testkit.output_reference_2,
    testkit.output(
      address.from_script(testkit.script_hash_1),
      assets.from_asset(testkit.nft_policy, constants.pool_nft_name, 1),
      Void,
    ),
  )
  let deposit_input = testkit.input(
    testkit.output_reference_1,
    testkit.output(
      address.from_script(testkit.script_hash_2),
      assets.from_lovelace(5_000_000),
      deposit_datum(),
    ),
  )
  testkit.transaction(
    [deposit_input, pool],
    [],
    [],
    assets.zero,
    [],
    interval.everything,
  )
}

fn refund_transaction() -> Transaction {
  let tx = absorb_transaction()
  expect [deposit_input, _pool] = tx.inputs
  Transaction {
    ..tx,
    inputs: [deposit_input],
    extra_signatories: [testkit.key_hash_1],
  }
}

test dep_00_absorb_with_pool_nft() {
  deposit.spend(
    testkit.nft_policy,
    Some(deposit_datum()),
    Absorb,
    testkit.output_reference_1,
    absorb_transaction(),
  )
}

test dep_00_refund_with_signature() {
  deposit.spend(
    testkit.nft_policy,
    Some(deposit_datum()),
    Refund,
    testkit.output_reference_1,
    refund_transaction(),
  )
}

test dep_01_absorb_without_pool_nft() fail {
  let base = absorb_transaction()
  expect [deposit_input, _pool] = base.inputs
  let tx = Transaction { ..base, inputs: [deposit_input] }
  expect
    deposit.spend(
      testkit.nft_policy,
      Some(deposit_datum()),
      Absorb,
      testkit.output_reference_1,
      tx,
    )
  True
}

test dep_01_absorb_wrong_policy() fail {
  let base = absorb_transaction()
  expect [deposit_input, pool] = base.inputs
  let output = Output {
    ..pool.output,
    value: assets.from_asset(testkit.script_hash_2, constants.pool_nft_name, 1),
  }
  let tx = Transaction {
    ..base,
    inputs: [deposit_input, Input { ..pool, output }],
  }
  expect
    deposit.spend(
      testkit.nft_policy,
      Some(deposit_datum()),
      Absorb,
      testkit.output_reference_1,
      tx,
    )
  True
}

test dep_01_absorb_wrong_quantity() fail {
  let base = absorb_transaction()
  expect [deposit_input, pool] = base.inputs
  let output = Output {
    ..pool.output,
    value: assets.from_asset(testkit.nft_policy, constants.pool_nft_name, 2),
  }
  let tx = Transaction {
    ..base,
    inputs: [deposit_input, Input { ..pool, output }],
  }
  expect
    deposit.spend(
      testkit.nft_policy,
      Some(deposit_datum()),
      Absorb,
      testkit.output_reference_1,
      tx,
    )
  True
}

test dep_02_refund_without_signature() fail {
  let base = refund_transaction()
  let tx = Transaction { ..base, extra_signatories: [] }
  expect
    deposit.spend(
      testkit.nft_policy,
      Some(deposit_datum()),
      Refund,
      testkit.output_reference_1,
      tx,
    )
  True
}

test dep_02_refund_wrong_signature() fail {
  let base = refund_transaction()
  let tx = Transaction { ..base, extra_signatories: [testkit.key_hash_2] }
  expect
    deposit.spend(
      testkit.nft_policy,
      Some(deposit_datum()),
      Refund,
      testkit.output_reference_1,
      tx,
    )
  True
}

test dep_02_absorb_missing_datum() fail {
  let tx = absorb_transaction()
  expect
    deposit.spend(
      testkit.nft_policy,
      None,
      Absorb,
      testkit.output_reference_1,
      tx,
    )
  True
}

test dep_02_refund_missing_datum() fail {
  let tx = refund_transaction()
  expect
    deposit.spend(
      testkit.nft_policy,
      None,
      Refund,
      testkit.output_reference_1,
      tx,
    )
  True
}
