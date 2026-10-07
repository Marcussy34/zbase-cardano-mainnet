use aiken/builtin
use aiken/collection/dict
use aiken/collection/list
use aiken/interval
use aiken/primitive/bytearray
use cardano/address
use cardano/assets.{PolicyId}
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use zx402/constants
use zx402/groth16.{fr_order, in_field}
use zx402/testkit
use zx402/types.{AspDatum}

validator asp(nft_policy: PolicyId) {
  spend(
    datum: Option<AspDatum>,
    _redeemer: Data,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(old) = datum
    let own = transaction.resolve_input(self.inputs, own_ref)
    expect
      assets.quantity_of(own.value, nft_policy, constants.asp_nft_name) == 1
    // Count old operators, so the new datum cannot authorize its own update.
    expect
      list.count(
        list.unique(old.operators),
        fn(key) { list.has(self.extra_signatories, key) },
      ) >= old.threshold
    expect dict.is_empty(assets.tokens(self.mint, nft_policy))
    // Count the payment credential before rejecting a stake credential.
    expect [continuing] = list.filter(
      self.outputs,
      fn(output) {
        output.address.payment_credential == own.address.payment_credential
      },
    )
    expect InlineDatum(raw) = continuing.datum
    expect next: AspDatum = raw
    and {
      continuing.address.stake_credential == None,
      assets.quantity_of(continuing.value, nft_policy, constants.asp_nft_name) == 1,
      valid_asp_datum(next),
    }
  }

  else(_) {
    fail
  }
}

fn valid_asp_datum(datum: AspDatum) -> Bool {
  let count = list.length(datum.operators)
  and {
    in_field(datum.root),
    count > 0,
    list.length(list.unique(datum.operators)) == count,
    list.all(
      datum.operators,
      fn(key) { builtin.length_of_bytearray(key) == 28 },
    ),
    datum.threshold >= 1,
    datum.threshold <= count,
    builtin.length_of_bytearray(datum.uri) <= 256,
  }
}

fn asp_datum() -> AspDatum {
  AspDatum {
    root: 42,
    operators: [testkit.key_hash_1, testkit.key_hash_2, testkit.key_hash_3],
    threshold: 2,
    uri: "ipfs://asp",
  }
}

fn next_asp_datum() -> AspDatum {
  let old = asp_datum()
  AspDatum { ..old, root: 43 }
}

fn asp_transaction() -> Transaction {
  let old = asp_datum()
  let value = assets.from_lovelace(2_000_000)
    |> assets.add(testkit.nft_policy, constants.asp_nft_name, 1)
  let output = testkit.output(
    address.from_script(testkit.script_hash_1),
    value,
    old,
  )
  let next = testkit.output(output.address, value, next_asp_datum())
  testkit.transaction(
    [testkit.input(testkit.output_reference_1, output)],
    [],
    [next],
    assets.zero,
    [testkit.key_hash_1, testkit.key_hash_2],
    interval.everything,
  )
}

test asp_00_exact_operator_threshold() {
  asp.spend(
    testkit.nft_policy,
    Some(asp_datum()),
    Void,
    testkit.output_reference_1,
    asp_transaction(),
  )
}

fn with_asp_datum(next: AspDatum) -> Transaction {
  let base = asp_transaction()
  expect [output] = base.outputs
  Transaction {
    ..base,
    outputs: [Output { ..output, datum: InlineDatum(next) }],
  }
}

test asp_02_root_at_field_order() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(AspDatum { ..next, root: fr_order })
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_02_root_above_field_order() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(AspDatum { ..next, root: fr_order + 5 })
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_02_negative_root() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(AspDatum { ..next, root: -1 })
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_uri_too_long() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(
    AspDatum { ..next, uri: bytearray.replicate(257, 97) },
  )
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_empty_operators() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(AspDatum { ..next, operators: [] })
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_duplicate_operators() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(
    AspDatum {
      ..next,
      operators: [testkit.key_hash_1, testkit.key_hash_1, testkit.key_hash_3],
    },
  )
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_short_operator_hash() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(
    AspDatum {
      ..next,
      operators: [#"11", testkit.key_hash_2, testkit.key_hash_3],
    },
  )
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_long_operator_hash() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(
    AspDatum {
      ..next,
      operators: [
        #"1111111111111111111111111111111111111111111111111111111111",
        testkit.key_hash_2,
        testkit.key_hash_3,
      ],
    },
  )
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_zero_threshold() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(AspDatum { ..next, threshold: 0 })
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_negative_threshold() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(AspDatum { ..next, threshold: -1 })
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_threshold_above_operator_count() fail {
  let next = next_asp_datum()
  let tx = with_asp_datum(AspDatum { ..next, threshold: 4 })
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_01_below_threshold() fail {
  let base = asp_transaction()
  let tx = Transaction { ..base, extra_signatories: [testkit.key_hash_1] }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_01_duplicate_signatures() fail {
  let base = asp_transaction()
  let tx = Transaction {
    ..base,
    extra_signatories: [testkit.key_hash_1, testkit.key_hash_1],
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_01_only_unrelated_signatures() fail {
  let base = asp_transaction()
  let tx = Transaction {
    ..base,
    extra_signatories: [testkit.key_hash_4, testkit.script_hash_2],
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_nft_leaves_address() fail {
  let base = asp_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [
      Output {
        ..output,
        address: address.from_verification_key(testkit.key_hash_4),
      },
    ],
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_missing_output_datum() fail {
  let base = asp_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [Output { ..output, datum: NoDatum }],
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_datum_hash_is_not_inline() fail {
  let base = asp_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [
      Output {
        ..output,
        datum: DatumHash(
          #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
      },
    ],
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_malformed_output_datum() fail {
  let base = asp_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [Output { ..output, datum: InlineDatum(42) }],
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_output_has_stake_credential() fail {
  let base = asp_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [
      Output {
        ..output,
        address: address.with_delegation_key(output.address, testkit.key_hash_4),
      },
    ],
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_missing_output_nft() fail {
  let base = asp_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [
      Output {
        ..output,
        value: assets.add(
          output.value,
          testkit.nft_policy,
          constants.asp_nft_name,
          -1,
        ),
      },
    ],
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_wrong_output_nft_quantity() fail {
  let base = asp_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [
      Output {
        ..output,
        value: assets.add(
          output.value,
          testkit.nft_policy,
          constants.asp_nft_name,
          1,
        ),
      },
    ],
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_two_continuing_outputs() fail {
  let base = asp_transaction()
  expect [output] = base.outputs
  let extra = Output { ..output, value: assets.from_lovelace(2_000_000) }
  let tx = Transaction { ..base, outputs: [output, extra] }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_missing_input_nft() fail {
  let base = asp_transaction()
  expect [input] = base.inputs
  let output = Output { ..input.output, value: assets.from_lovelace(2_000_000) }
  let tx = Transaction { ..base, inputs: [Input { ..input, output }] }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_missing_input_datum() fail {
  let tx = asp_transaction()
  expect
    asp.spend(testkit.nft_policy, None, Void, testkit.output_reference_1, tx)
  True
}

test asp_03_wrong_spent_reference() fail {
  let tx = asp_transaction()
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_2,
      tx,
    )
  True
}

test asp_03_mint_under_nft_policy() fail {
  let base = asp_transaction()
  let tx = Transaction {
    ..base,
    mint: assets.from_asset(testkit.nft_policy, "extra", 1),
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test asp_03_burn_under_nft_policy() fail {
  let base = asp_transaction()
  let tx = Transaction {
    ..base,
    mint: assets.from_asset(testkit.nft_policy, "extra", -1),
  }
  expect
    asp.spend(
      testkit.nft_policy,
      Some(asp_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}
