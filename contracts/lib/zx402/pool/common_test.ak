use aiken/collection/list
use aiken/merkle_patricia_forestry as mpf
use cardano/address
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use zx402/constants
use zx402/groth16.{Proof, fr_order}
use zx402/pool
use zx402/pool/common
use zx402/pool/kit
use zx402/testkit
use zx402/types.{
  AssetClass, CollectFees, Insert, PoolDatum, Ragequit, Settle, SettleIntent,
}

fn validate(tx: Transaction) -> Bool {
  pool.validate(
    kit.params(kit.placeholder_key, kit.placeholder_key, kit.placeholder_key),
    Some(kit.fees_datum()),
    CollectFees { amount: 2_000_000 },
    kit.pool_ref,
    tx,
  )
}

test pool_p1_missing_input_nft() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [own] = base.inputs
  let output = Output { ..own.output, value: assets.from_lovelace(25_000_000) }
  expect validate(Transaction { ..base, inputs: [Input { ..own, output }] })
  True
}

test pool_p1_wrong_input_policy() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [own] = base.inputs
  let value = assets.from_lovelace(25_000_000)
    |> assets.add(testkit.script_hash_1, constants.pool_nft_name, 1)
  let output = Output { ..own.output, value }
  expect validate(Transaction { ..base, inputs: [Input { ..own, output }] })
  True
}

test pool_p2_wrong_output_address() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let continuing = Output { ..continuing, address: kit.treasury_address }
  expect validate(Transaction { ..base, outputs: [continuing, treasury] })
  True
}

test pool_p2_missing_output_nft() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let continuing = Output {
    ..continuing,
    value: assets.from_lovelace(23_000_000),
  }
  expect validate(Transaction { ..base, outputs: [continuing, treasury] })
  True
}

test pool_p2_continuing_at_index_one() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  expect validate(Transaction { ..base, outputs: [treasury, continuing] })
  True
}

test pool_p3_foreign_token() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let value = assets.add(continuing.value, testkit.script_hash_1, "foreign", 1)
  expect
    validate(
      Transaction {
        ..base,
        outputs: [Output { ..continuing, value }, treasury],
      },
    )
  True
}

test pool_p3_reference_script() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let continuing = Output {
    ..continuing,
    reference_script: Some(testkit.script_hash_1),
  }
  expect validate(Transaction { ..base, outputs: [continuing, treasury] })
  True
}

test pool_p4_roots_changed() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  let next = kit.collected_datum(2_000_000)
  expect validate(kit.with_out_datum(base, PoolDatum { ..next, roots: [42] }))
  True
}

test pool_p4_size_changed() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  let next = kit.collected_datum(2_000_000)
  expect
    validate(
      kit.with_out_datum(base, PoolDatum { ..next, size: next.size + 1 }),
    )
  True
}

test pool_p4_queue_changed() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  let next = kit.collected_datum(2_000_000)
  expect validate(kit.with_out_datum(base, PoolDatum { ..next, queue: [42] }))
  True
}

test pool_p4_nullifier_root_changed() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  let next = kit.collected_datum(2_000_000)
  expect
    validate(
      kit.with_out_datum(
        base,
        PoolDatum {
          ..next,
          nullifier_root: #"1111111111111111111111111111111111111111111111111111111111111111",
        },
      ),
    )
  True
}

test pool_p4_output_datum_hash() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let continuing = Output {
    ..continuing,
    datum: DatumHash(testkit.output_reference_1.transaction_id),
  }
  expect validate(Transaction { ..base, outputs: [continuing, treasury] })
  True
}

test pool_p4_no_output_datum() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let continuing = Output { ..continuing, datum: NoDatum }
  expect validate(Transaction { ..base, outputs: [continuing, treasury] })
  True
}

test pool_p5_missing_config() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect validate(Transaction { ..base, reference_inputs: [] })
  True
}

test pool_p5_wrong_config_policy() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [config] = base.reference_inputs
  let value = assets.from_lovelace(2_000_000)
    |> assets.add(testkit.script_hash_1, constants.config_nft_name, 1)
  let output = Output { ..config.output, value }
  expect
    validate(
      Transaction { ..base, reference_inputs: [Input { ..config, output }] },
    )
  True
}

test pool_p5_config_spent_not_referenced() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [config] = base.reference_inputs
  expect
    validate(
      Transaction {
        ..base,
        inputs: [config, ..base.inputs],
        reference_inputs: [],
      },
    )
  True
}

test dispatcher_missing_datum() fail {
  expect
    pool.validate(
      kit.params(kit.placeholder_key, kit.placeholder_key, kit.placeholder_key),
      None,
      CollectFees { amount: 2_000_000 },
      kit.pool_ref,
      kit.collect_fees_transaction(2_000_000),
    )
  True
}

test dispatcher_insert_not_implemented() fail {
  expect
    pool.validate(
      kit.params(kit.placeholder_key, kit.placeholder_key, kit.placeholder_key),
      Some(kit.fees_datum()),
      Insert { proof: Proof { a: "", b: "", c: "" }, flush: 0 },
      kit.pool_ref,
      kit.collect_fees_transaction(2_000_000),
    )
  True
}

test dispatcher_settle_not_implemented() fail {
  expect
    pool.validate(
      kit.params(kit.placeholder_key, kit.placeholder_key, kit.placeholder_key),
      Some(kit.fees_datum()),
      Settle {
        proof: Proof { a: "", b: "", c: "" },
        nullifier_hash: 1,
        new_commitment: 2,
        withdrawn: 2_000_000,
        state_root: 3,
        intent: SettleIntent {
          pool_id: kit.nft_policy,
          payouts: [],
          relayer: None,
          valid_until: 0,
        },
        nullifier_proof: [],
      },
      kit.pool_ref,
      kit.collect_fees_transaction(2_000_000),
    )
  True
}

test dispatcher_ragequit_not_implemented() fail {
  expect
    pool.validate(
      kit.params(kit.placeholder_key, kit.placeholder_key, kit.placeholder_key),
      Some(kit.fees_datum()),
      Ragequit {
        proof: Proof { a: "", b: "", c: "" },
        nullifier_hash: 1,
        value: 2_000_000,
        state_root: 3,
        deposit_ref: testkit.output_reference_2,
        refund: testkit.key_hash_1,
        nullifier_proof: [],
      },
      kit.pool_ref,
      kit.collect_fees_transaction(2_000_000),
    )
  True
}

fn context(tx: Transaction) -> common.PoolContext {
  common.load(
    kit.params(kit.placeholder_key, kit.placeholder_key, kit.placeholder_key),
    Some(kit.fees_datum()),
    kit.pool_ref,
    tx,
  )
}

test pool_s3_asp_root_from_authentic_reference() {
  let base = kit.collect_fees_transaction(2_000_000)
  let tx = Transaction {
    ..base,
    reference_inputs: [kit.asp_ref(42), ..base.reference_inputs],
  }
  common.asp_root(context(tx)) == 42
}

test pool_s3_asp_reference_missing() fail {
  expect common.asp_root(context(kit.collect_fees_transaction(2_000_000))) >= 0
  True
}

test pool_s3_asp_wrong_policy() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  let asp = kit.asp_ref(42)
  let value = assets.from_lovelace(2_000_000)
    |> assets.add(testkit.script_hash_1, constants.asp_nft_name, 1)
  let asp = Input { ..asp, output: Output { ..asp.output, value } }
  let tx = Transaction {
    ..base,
    reference_inputs: [asp, ..base.reference_inputs],
  }
  expect common.asp_root(context(tx)) >= 0
  True
}

test pool_s8_r6_nullifier_insert_uses_big_endian_key_and_set_value() {
  let root = common.nullifier_insert(mpf.root(mpf.empty), 1, [])
  mpf.has(
    mpf.from_root(root),
    #"0000000000000000000000000000000000000000000000000000000000000001",
    #"01",
    [],
  )
}

test pool_s8_r6_nullifier_already_present() fail {
  let root = mpf.empty
    |> mpf.insert(
        #"0000000000000000000000000000000000000000000000000000000000000001",
        #"01",
        [],
      )
    |> mpf.root
  expect common.nullifier_insert(root, 1, []) != #""
  True
}

test pool_s8_r6_nullifier_wrong_proof() fail {
  let root = mpf.empty
    |> mpf.insert(
        #"0000000000000000000000000000000000000000000000000000000000000001",
        #"01",
        [],
      )
    |> mpf.root
  expect common.nullifier_insert(root, 2, []) != #""
  True
}

test pool_s8_r6_nullifier_negative() fail {
  expect common.nullifier_insert(mpf.root(mpf.empty), -1, []) != #""
  True
}

test pool_s8_r6_nullifier_at_field_order() fail {
  expect common.nullifier_insert(mpf.root(mpf.empty), fr_order, []) != #""
  True
}

test pool_s14_r3_signed_by_required_key() {
  let base = kit.collect_fees_transaction(2_000_000)
  let tx = Transaction {
    ..base,
    extra_signatories: [testkit.key_hash_2, testkit.key_hash_1],
  }
  common.signed_by(tx, testkit.key_hash_1)
}

test pool_s14_r3_unrelated_key_does_not_sign() {
  let base = kit.collect_fees_transaction(2_000_000)
  let tx = Transaction { ..base, extra_signatories: [testkit.key_hash_2] }
  !common.signed_by(tx, testkit.key_hash_1)
}

test pool_i7_deposit_inputs_keep_order_and_match_payment_credential() {
  let base = kit.collect_fees_transaction(2_000_000)
  let first = testkit.input(
    testkit.output_reference_3,
    testkit.output(
      address.from_script(kit.deposit_script)
        |> address.with_delegation_key(testkit.key_hash_1),
      assets.from_lovelace(5_000_000),
      Void,
    ),
  )
  let second = testkit.input(
    testkit.output_reference_2,
    testkit.output(
      address.from_script(kit.deposit_script),
      assets.from_lovelace(5_000_000),
      Void,
    ),
  )
  let same_hash_key = testkit.input(
    OutputReference { ..testkit.output_reference_1, output_index: 3 },
    testkit.output(
      address.from_verification_key(kit.deposit_script),
      assets.from_lovelace(5_000_000),
      Void,
    ),
  )
  let tx = Transaction {
    ..base,
    inputs: [first, same_hash_key, ..base.inputs] |> list.concat([second]),
  }
  common.deposit_inputs(context(tx)) == [first, second]
}

test pool_c4_asset_amount_selects_token_units() {
  let asset = AssetClass { policy: testkit.script_hash_1, name: "token" }
  let value = assets.from_lovelace(6_000_000)
    |> assets.add(asset.policy, asset.name, 42)
    |> assets.add(asset.policy, "other", 99)
  common.asset_amount(asset, value) == 42
}

test pool_p1_input_nft_quantity_two() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [own] = base.inputs
  let output = Output {
    ..own.output,
    value: assets.add(
      own.output.value,
      kit.nft_policy,
      constants.pool_nft_name,
      1,
    ),
  }
  expect validate(Transaction { ..base, inputs: [Input { ..own, output }] })
  True
}

test pool_p1_own_reference_missing() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [own] = base.inputs
  expect
    validate(
      Transaction {
        ..base,
        inputs: [Input { ..own, output_reference: testkit.output_reference_3 }],
      },
    )
  True
}

test pool_p2_output_nft_quantity_two() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let value = assets.add(
    continuing.value,
    kit.nft_policy,
    constants.pool_nft_name,
    1,
  )
  expect
    validate(
      Transaction {
        ..base,
        outputs: [Output { ..continuing, value }, treasury],
      },
    )
  True
}

test pool_p3_foreign_name_under_nft_policy() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  let value = assets.add(continuing.value, kit.nft_policy, "foreign", 1)
  expect
    validate(
      Transaction {
        ..base,
        outputs: [Output { ..continuing, value }, treasury],
      },
    )
  True
}

test pool_p4_malformed_inline_datum() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [continuing, treasury] = base.outputs
  expect
    validate(
      Transaction {
        ..base,
        outputs: [Output { ..continuing, datum: InlineDatum(42) }, treasury],
      },
    )
  True
}

test pool_p5_config_nft_quantity_two() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [config] = base.reference_inputs
  let output = Output {
    ..config.output,
    value: assets.add(
      config.output.value,
      kit.nft_policy,
      constants.config_nft_name,
      1,
    ),
  }
  expect
    validate(
      Transaction { ..base, reference_inputs: [Input { ..config, output }] },
    )
  True
}

test pool_p5_config_datum_hash() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [config] = base.reference_inputs
  let output = Output {
    ..config.output,
    datum: DatumHash(testkit.output_reference_1.transaction_id),
  }
  expect
    validate(
      Transaction { ..base, reference_inputs: [Input { ..config, output }] },
    )
  True
}

test pool_p5_malformed_config_datum() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  expect [config] = base.reference_inputs
  let output = Output { ..config.output, datum: InlineDatum(42) }
  expect
    validate(
      Transaction { ..base, reference_inputs: [Input { ..config, output }] },
    )
  True
}

test pool_s3_asp_nft_quantity_two() fail {
  let base = kit.collect_fees_transaction(2_000_000)
  let asp = kit.asp_ref(42)
  let output = Output {
    ..asp.output,
    value: assets.add(
      asp.output.value,
      kit.nft_policy,
      constants.asp_nft_name,
      1,
    ),
  }
  let tx = Transaction {
    ..base,
    reference_inputs: [Input { ..asp, output }, ..base.reference_inputs],
  }
  expect common.asp_root(context(tx)) >= 0
  True
}
