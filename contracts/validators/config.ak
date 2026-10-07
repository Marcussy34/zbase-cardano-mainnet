use aiken/builtin
use aiken/collection/dict
use aiken/collection/list
use aiken/interval
use cardano/address
use cardano/assets.{PolicyId}
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use zx402/constants
use zx402/testkit
use zx402/types.{ConfigDatum}

validator config(nft_policy: PolicyId) {
  spend(
    datum: Option<ConfigDatum>,
    _redeemer: Data,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(old) = datum
    let own = transaction.resolve_input(self.inputs, own_ref)
    expect
      assets.quantity_of(own.value, nft_policy, constants.config_nft_name) == 1
    // Count authorized keys once, even if a signer list repeats a key.
    expect
      list.count(
        list.unique(old.admins),
        fn(key) { list.has(self.extra_signatories, key) },
      ) >= old.admin_threshold
    expect dict.is_empty(assets.tokens(self.mint, nft_policy))
    // Include staked variants when counting, so an extra output cannot hide.
    expect [continuing] = list.filter(
      self.outputs,
      fn(output) {
        output.address.payment_credential == own.address.payment_credential
      },
    )
    expect InlineDatum(raw) = continuing.datum
    expect next: ConfigDatum = raw
    and {
      continuing.address.stake_credential == None,
      assets.quantity_of(
        continuing.value,
        nft_policy,
        constants.config_nft_name,
      ) == 1,
      valid_config_datum(next),
    }
  }

  else(_) {
    fail
  }
}

/// Validate config bounds, also mirrored by the off-chain genesis check.
pub fn valid_config_datum(datum: ConfigDatum) -> Bool {
  let count = list.length(datum.admins)
  and {
    datum.deposit_fee_bps >= 0,
    datum.deposit_fee_bps <= constants.max_deposit_fee_bps,
    datum.settle_fee_bps >= 0,
    datum.settle_fee_bps <= constants.max_settle_fee_bps,
    datum.crank_fee >= 0,
    datum.crank_fee <= constants.max_crank_fee,
    datum.min_deposit > 0,
    datum.min_deposit <= datum.max_deposit,
    datum.pool_cap >= 0,
    count > 0,
    list.length(list.unique(datum.admins)) == count,
    list.all(datum.admins, fn(key) { builtin.length_of_bytearray(key) == 28 }),
    datum.admin_threshold >= 1,
    datum.admin_threshold <= count,
  }
}

fn config_datum() -> ConfigDatum {
  ConfigDatum {
    admins: [testkit.key_hash_1, testkit.key_hash_2, testkit.key_hash_3],
    admin_threshold: 2,
    treasury: address.from_verification_key(testkit.key_hash_4),
    deposits_paused: False,
    min_deposit: 5_000_000,
    max_deposit: 50_000_000,
    pool_cap: 500_000_000,
    deposit_fee_bps: 0,
    settle_fee_bps: 0,
    crank_fee: 300_000,
  }
}

fn next_config_datum() -> ConfigDatum {
  let old = config_datum()
  ConfigDatum { ..old, deposits_paused: True }
}

fn config_transaction() -> Transaction {
  let old = config_datum()
  let value = assets.from_lovelace(2_000_000)
    |> assets.add(testkit.nft_policy, constants.config_nft_name, 1)
  let output = testkit.output(
    address.from_script(testkit.script_hash_1),
    value,
    old,
  )
  let next = testkit.output(output.address, value, next_config_datum())
  testkit.transaction(
    [testkit.input(testkit.output_reference_1, output)],
    [],
    [next],
    assets.zero,
    [testkit.key_hash_1, testkit.key_hash_2],
    interval.everything,
  )
}

test cfg_00_exact_admin_threshold() {
  config.spend(
    testkit.nft_policy,
    Some(config_datum()),
    Void,
    testkit.output_reference_1,
    config_transaction(),
  )
}

fn with_config_datum(next: ConfigDatum) -> Transaction {
  let base = config_transaction()
  expect [output] = base.outputs
  Transaction {
    ..base,
    outputs: [Output { ..output, datum: InlineDatum(next) }],
  }
}

test cfg_02_deposit_fee_above_cap() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, deposit_fee_bps: 101 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_settle_fee_above_cap() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, settle_fee_bps: 1001 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_crank_fee_above_cap() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, crank_fee: 1_000_001 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_negative_deposit_fee() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, deposit_fee_bps: -1 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_negative_settle_fee() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, settle_fee_bps: -1 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_negative_crank_fee() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, crank_fee: -1 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_min_deposit_above_max() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, min_deposit: 50_000_001 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_zero_min_deposit() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, min_deposit: 0 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_negative_min_deposit() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, min_deposit: -1 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_empty_admins() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, admins: [] })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_duplicate_admins() fail {
  let next = next_config_datum()
  let tx = with_config_datum(
    ConfigDatum {
      ..next,
      admins: [testkit.key_hash_1, testkit.key_hash_1, testkit.key_hash_3],
    },
  )
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_zero_threshold() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, admin_threshold: 0 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_threshold_above_admin_count() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, admin_threshold: 4 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_negative_threshold() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, admin_threshold: -1 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_negative_pool_cap() fail {
  let next = next_config_datum()
  let tx = with_config_datum(ConfigDatum { ..next, pool_cap: -1 })
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_short_admin_hash() fail {
  let next = next_config_datum()
  let tx = with_config_datum(
    ConfigDatum {
      ..next,
      admins: [#"11", testkit.key_hash_2, testkit.key_hash_3],
    },
  )
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_02_long_admin_hash() fail {
  let next = next_config_datum()
  let tx = with_config_datum(
    ConfigDatum {
      ..next,
      admins: [
        #"1111111111111111111111111111111111111111111111111111111111",
        testkit.key_hash_2,
        testkit.key_hash_3,
      ],
    },
  )
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_01_below_threshold() fail {
  let base = config_transaction()
  let tx = Transaction { ..base, extra_signatories: [testkit.key_hash_1] }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_01_duplicate_signatures() fail {
  let base = config_transaction()
  let tx = Transaction {
    ..base,
    extra_signatories: [testkit.key_hash_1, testkit.key_hash_1],
  }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_01_only_unrelated_signatures() fail {
  let base = config_transaction()
  let tx = Transaction {
    ..base,
    extra_signatories: [testkit.key_hash_4, testkit.script_hash_2],
  }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_nft_leaves_address() fail {
  let base = config_transaction()
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
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_missing_output_datum() fail {
  let base = config_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [Output { ..output, datum: NoDatum }],
  }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_datum_hash_is_not_inline() fail {
  let base = config_transaction()
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
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_malformed_output_datum() fail {
  let base = config_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [Output { ..output, datum: InlineDatum(42) }],
  }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_output_has_stake_credential() fail {
  let base = config_transaction()
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
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_missing_output_nft() fail {
  let base = config_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [
      Output {
        ..output,
        value: assets.add(
          output.value,
          testkit.nft_policy,
          constants.config_nft_name,
          -1,
        ),
      },
    ],
  }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_wrong_output_nft_quantity() fail {
  let base = config_transaction()
  expect [output] = base.outputs
  let tx = Transaction {
    ..base,
    outputs: [
      Output {
        ..output,
        value: assets.add(
          output.value,
          testkit.nft_policy,
          constants.config_nft_name,
          1,
        ),
      },
    ],
  }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_two_continuing_outputs() fail {
  let base = config_transaction()
  expect [output] = base.outputs
  let extra = Output { ..output, value: assets.from_lovelace(2_000_000) }
  let tx = Transaction { ..base, outputs: [output, extra] }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_missing_input_nft() fail {
  let base = config_transaction()
  expect [input] = base.inputs
  let output = Output { ..input.output, value: assets.from_lovelace(2_000_000) }
  let tx = Transaction { ..base, inputs: [Input { ..input, output }] }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_missing_input_datum() fail {
  let tx = config_transaction()
  expect
    config.spend(testkit.nft_policy, None, Void, testkit.output_reference_1, tx)
  True
}

test cfg_03_wrong_spent_reference() fail {
  let tx = config_transaction()
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_2,
      tx,
    )
  True
}

test cfg_03_mint_under_nft_policy() fail {
  let base = config_transaction()
  let tx = Transaction {
    ..base,
    mint: assets.from_asset(testkit.nft_policy, "extra", 1),
  }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}

test cfg_03_burn_under_nft_policy() fail {
  let base = config_transaction()
  let tx = Transaction {
    ..base,
    mint: assets.from_asset(testkit.nft_policy, "extra", -1),
  }
  expect
    config.spend(
      testkit.nft_policy,
      Some(config_datum()),
      Void,
      testkit.output_reference_1,
      tx,
    )
  True
}
