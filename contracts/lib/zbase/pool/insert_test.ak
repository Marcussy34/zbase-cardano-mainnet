use aiken/builtin
use aiken/collection/list
use aiken/interval
use cardano/address
use cardano/assets
use cardano/transaction.{
  Datum, DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference,
  Transaction,
}
use zbase/constants
use zbase/fixtures/common as fixture_keys
use zbase/fixtures/insert as f
use zbase/groth16
use zbase/pool
use zbase/pool/common.{PoolParams}
use zbase/pool/kit
use zbase/testkit
use zbase/types.{AssetClass, ConfigDatum, DepositDatum, Insert, PoolDatum}

type Case {
  datum: PoolDatum,
  proof: groth16.Proof,
  flush: Int,
  tx: Transaction,
  params: PoolParams,
}

fn scenario(
  datum: PoolDatum,
  out_datum: PoolDatum,
  proof: groth16.Proof,
  flush: Int,
  config: ConfigDatum,
  balance_in: Int,
  balance_out: Int,
  deposits: List<(OutputReference, DepositDatum, Int)>,
) -> Case {
  let inputs = list.map(
    deposits,
    fn(deposit) {
      let (reference, deposit_datum, gross) = deposit
      testkit.input(
        reference,
        testkit.output(
          address.from_script(kit.deposit_script),
          assets.from_lovelace(gross),
          deposit_datum,
        ),
      )
    },
  )
  Case {
    datum,
    proof,
    flush,
    params: kit.params(
      kit.placeholder_key,
      fixture_keys.vk_insert,
      kit.placeholder_key,
    ),
    tx: testkit.transaction(
      [kit.pool_input(datum, balance_in), ..inputs],
      [kit.config_ref(config)],
      [kit.pool_output(out_datum, balance_out)],
      assets.zero,
      [],
      interval.everything,
    ),
  }
}

fn validate(case: Case) -> Bool {
  pool.validate(
    case.params,
    Some(case.datum),
    Insert { proof: case.proof, flush: case.flush },
    kit.pool_ref,
    case.tx,
  )
}

fn with_config(case: Case, config: ConfigDatum) -> Case {
  Case {
    ..case,
    tx: Transaction { ..case.tx, reference_inputs: [kit.config_ref(config)] },
  }
}

fn out_datum(case: Case) -> PoolDatum {
  expect [output] = case.tx.outputs
  expect InlineDatum(raw) = output.datum
  expect datum: PoolDatum = raw
  datum
}

fn with_out(case: Case, datum: PoolDatum) -> Case {
  Case { ..case, tx: kit.with_out_datum(case.tx, datum) }
}

// Keep both representations of the spent datum consistent in mutation tests.
fn with_datum(case: Case, datum: PoolDatum) -> Case {
  expect [own, ..inputs] = case.tx.inputs
  let own = Input {
    ..own,
    output: Output { ..own.output, datum: InlineDatum(datum) },
  }
  Case { ..case, datum, tx: Transaction { ..case.tx, inputs: [own, ..inputs] } }
}

fn with_deposit(case: Case, change: fn(Input) -> Input) -> Case {
  expect [own, deposit, ..inputs] = case.tx.inputs
  Case {
    ..case,
    tx: Transaction { ..case.tx, inputs: [own, change(deposit), ..inputs] },
  }
}

fn with_deposit_datum(case: Case, datum: Datum) -> Case {
  with_deposit(
    case,
    fn(input) { Input { ..input, output: Output { ..input.output, datum } } },
  )
}

fn deposit_datum(case: Case) -> DepositDatum {
  expect [_, deposit, ..] = case.tx.inputs
  expect InlineDatum(raw) = deposit.output.datum
  expect datum: DepositDatum = raw
  datum
}

fn with_balance_delta(case: Case, delta: Int) -> Case {
  expect [output] = case.tx.outputs
  let output = Output {
    ..output,
    value: assets.add(output.value, "", "", delta),
  }
  Case { ..case, tx: Transaction { ..case.tx, outputs: [output] } }
}

fn one_deposit() -> Case {
  scenario(
    f.one_deposit_datum,
    f.one_deposit_out_datum,
    f.one_deposit_proof,
    f.one_deposit_flush,
    f.one_deposit_config,
    f.one_deposit_balance_in,
    f.one_deposit_balance_out,
    f.one_deposit_deposits,
  )
}

fn four_deposits() -> Case {
  scenario(
    f.four_deposits_datum,
    f.four_deposits_out_datum,
    f.four_deposits_proof,
    f.four_deposits_flush,
    f.four_deposits_config,
    f.four_deposits_balance_in,
    f.four_deposits_balance_out,
    f.four_deposits_deposits,
  )
}

fn one_note() -> Case {
  scenario(
    f.one_note_datum,
    f.one_note_out_datum,
    f.one_note_proof,
    f.one_note_flush,
    f.one_note_config,
    f.one_note_balance_in,
    f.one_note_balance_out,
    f.one_note_deposits,
  )
}

fn four_notes() -> Case {
  scenario(
    f.four_notes_datum,
    f.four_notes_out_datum,
    f.four_notes_proof,
    f.four_notes_flush,
    f.four_notes_config,
    f.four_notes_balance_in,
    f.four_notes_balance_out,
    f.four_notes_deposits,
  )
}

fn two_notes_two_deposits() -> Case {
  scenario(
    f.two_notes_two_deposits_datum,
    f.two_notes_two_deposits_out_datum,
    f.two_notes_two_deposits_proof,
    f.two_notes_two_deposits_flush,
    f.two_notes_two_deposits_config,
    f.two_notes_two_deposits_balance_in,
    f.two_notes_two_deposits_balance_out,
    f.two_notes_two_deposits_deposits,
  )
}

fn fee_bps() -> Case {
  scenario(
    f.fee_bps_datum,
    f.fee_bps_out_datum,
    f.fee_bps_proof,
    f.fee_bps_flush,
    f.fee_bps_config,
    f.fee_bps_balance_in,
    f.fee_bps_balance_out,
    f.fee_bps_deposits,
  )
}

fn wrong_value() -> Case {
  scenario(
    f.wrong_value_datum,
    f.wrong_value_out_datum,
    f.wrong_value_proof,
    f.wrong_value_flush,
    f.wrong_value_config,
    f.wrong_value_balance_in,
    f.wrong_value_balance_out,
    f.wrong_value_deposits,
  )
}

fn wrong_order() -> Case {
  scenario(
    f.wrong_order_datum,
    f.wrong_order_out_datum,
    f.wrong_order_proof,
    f.wrong_order_flush,
    f.wrong_order_config,
    f.wrong_order_balance_in,
    f.wrong_order_balance_out,
    f.wrong_order_deposits,
  )
}

test pool_i0_one_deposit() {
  validate(one_deposit())
}

test pool_i0_four_deposits() {
  validate(four_deposits())
}

test pool_i0_one_note() {
  validate(one_note())
}

test pool_i0_four_notes() {
  validate(four_notes())
}

test pool_i0_two_notes_two_deposits() {
  validate(two_notes_two_deposits())
}

test pool_i0_fee_bps() {
  validate(fee_bps())
}

test bud_02_four_deposits() {
  validate(four_deposits())
}

test bud_03_four_notes() {
  validate(four_notes())
}

test pool_i1_zero_slots() fail {
  let case = one_note()
  expect validate(Case { ..case, flush: 0 })
  True
}

test pool_i1_five_slots() fail {
  let case = four_deposits()
  // A queued note can remain untouched in an otherwise valid deposit insert.
  let datum = PoolDatum { ..case.datum, queue: [42] }
  let out = PoolDatum { ..out_datum(case), queue: [42] }
  let case = with_out(with_datum(case, datum), out)
  expect validate(Case { ..case, flush: 1 })
  True
}

test pool_i1_flush_above_queue_length() fail {
  let case = one_deposit()
  expect validate(Case { ..case, flush: 1 })
  True
}

test pool_i1_negative_flush() fail {
  let case = two_notes_two_deposits()
  expect validate(Case { ..case, flush: -1 })
  True
}

test pool_i2_deposits_paused() fail {
  expect
    validate(
      with_config(
        one_deposit(),
        ConfigDatum { ..kit.m0_config(), deposits_paused: True },
      ),
    )
  True
}

test pool_i2_notes_pass_while_paused() {
  validate(
    with_config(
      one_note(),
      ConfigDatum { ..kit.m0_config(), deposits_paused: True },
    ),
  )
}

test pool_i3_hashed_datum() fail {
  expect
    validate(
      with_deposit_datum(
        one_deposit(),
        DatumHash(testkit.output_reference_1.transaction_id),
      ),
    )
  True
}

test pool_i3_no_datum() fail {
  expect validate(with_deposit_datum(one_deposit(), NoDatum))
  True
}

test pool_i3_malformed_inline_datum() fail {
  expect validate(with_deposit_datum(one_deposit(), InlineDatum(42)))
  True
}

test pool_i3_zero_precommitment() fail {
  let case = one_deposit()
  let datum = DepositDatum { ..deposit_datum(case), precommitment: 0 }
  expect validate(with_deposit_datum(case, InlineDatum(datum)))
  True
}

test pool_i3_precommitment_at_r() fail {
  let case = one_deposit()
  let datum = DepositDatum {
    ..deposit_datum(case),
    precommitment: groth16.fr_order,
  }
  expect validate(with_deposit_datum(case, InlineDatum(datum)))
  True
}

test pool_i3_negative_precommitment() fail {
  let case = one_deposit()
  let datum = DepositDatum { ..deposit_datum(case), precommitment: -1 }
  expect validate(with_deposit_datum(case, InlineDatum(datum)))
  True
}

test pool_i4_below_minimum() fail {
  expect
    validate(
      with_config(
        one_deposit(),
        ConfigDatum { ..kit.m0_config(), min_deposit: 10_000_001 },
      ),
    )
  True
}

test pool_i4_above_maximum() fail {
  expect
    validate(
      with_config(
        one_deposit(),
        ConfigDatum { ..kit.m0_config(), max_deposit: 9_999_999 },
      ),
    )
  True
}

test pool_i4_deposit_at_minimum() {
  validate(
    with_config(
      one_deposit(),
      ConfigDatum { ..kit.m0_config(), min_deposit: 10_000_000 },
    ),
  )
}

test pool_i4_deposit_at_maximum() {
  validate(
    with_config(
      one_deposit(),
      ConfigDatum { ..kit.m0_config(), max_deposit: 10_000_000 },
    ),
  )
}

test pool_i5_wrong_value_proof() fail {
  // The output root belongs to this valid proof, so only chain value binding fails.
  expect validate(wrong_value())
  True
}

test pool_i5_deposit_changed_after_proving() fail {
  let case = with_deposit(
    one_deposit(),
    fn(input) {
      Input {
        ..input,
        output: Output {
          ..input.output,
          value: assets.add(input.output.value, "", "", 1),
        },
      }
    },
  )
  expect validate(case)
  True
}

test pool_i5_zero_credited_value() fail {
  expect
    validate(
      with_config(
        one_deposit(),
        ConfigDatum { ..kit.m0_config(), crank_fee: 10_000_000 },
      ),
    )
  True
}

test pool_i5_negative_credited_value() fail {
  expect
    validate(
      with_config(
        one_deposit(),
        ConfigDatum { ..kit.m0_config(), crank_fee: 10_000_001 },
      ),
    )
  True
}

test pool_i6_changed_deposit_reference() fail {
  let case = with_deposit(
    one_deposit(),
    fn(input) {
      Input {
        ..input,
        output_reference: OutputReference {
          ..input.output_reference,
          output_index: 4,
        },
      }
    },
  )
  expect validate(case)
  True
}

test pool_i6_changed_refund_key() fail {
  let case = one_deposit()
  let datum = DepositDatum { ..deposit_datum(case), refund: testkit.key_hash_4 }
  expect validate(with_deposit_datum(case, InlineDatum(datum)))
  True
}

fn replace_policy(output: Output, name: ByteArray, policy: ByteArray) -> Output {
  Output {
    ..output,
    value: output.value
      |> assets.add(kit.nft_policy, name, -1)
      |> assets.add(policy, name, 1),
  }
}

test pool_i6_changed_pool_id() fail {
  let case = one_deposit()
  let policy = testkit.script_hash_1
  expect [own, ..deposits] = case.tx.inputs
  expect [config] = case.tx.reference_inputs
  expect [continuing] = case.tx.outputs
  // Move all authenticated NFTs together to isolate the pool ID in the label.
  let tx = Transaction {
    ..case.tx,
    inputs: [
      Input {
        ..own,
        output: replace_policy(own.output, constants.pool_nft_name, policy),
      },
      ..deposits
    ],
    reference_inputs: [
      Input {
        ..config,
        output: replace_policy(config.output, constants.config_nft_name, policy),
      },
    ],
    outputs: [replace_policy(continuing, constants.pool_nft_name, policy)],
  }
  expect
    validate(
      Case {
        ..case,
        tx,
        params: PoolParams { ..case.params, nft_policy: policy },
      },
    )
  True
}

test pool_i7_wrong_order_proof() fail {
  expect validate(wrong_order())
  True
}

test pool_i7_deposit_input_order_changed() fail {
  let case = four_deposits()
  expect [own, first, second, ..rest] = case.tx.inputs
  expect
    validate(
      Case {
        ..case,
        tx: Transaction { ..case.tx, inputs: [own, second, first, ..rest] },
      },
    )
  True
}

fn with_old_root(case: Case, root: Int) -> Case {
  expect [_, ..old_roots] = case.datum.roots
  let datum = PoolDatum { ..case.datum, roots: [root, ..old_roots] }
  let out = out_datum(case)
  expect [new_root, _, ..history] = out.roots
  with_out(
    with_datum(case, datum),
    PoolDatum { ..out, roots: [new_root, root, ..history] },
  )
}

fn with_size(case: Case, delta: Int) -> Case {
  let datum = PoolDatum { ..case.datum, size: case.datum.size + delta }
  let out = PoolDatum { ..out_datum(case), size: out_datum(case).size + delta }
  with_out(with_datum(case, datum), out)
}

test pool_i8_changed_old_root() fail {
  let case = one_deposit()
  expect validate(with_old_root(case, list.expect_head(case.datum.roots) + 1))
  True
}

test pool_i8_changed_start_size() fail {
  expect validate(with_size(one_deposit(), 1))
  True
}

test pool_i8_old_root_plus_r() fail {
  let case = one_deposit()
  expect
    validate(
      with_old_root(case, list.expect_head(case.datum.roots) + groth16.fr_order),
    )
  True
}

test pool_i8_new_root_plus_r() fail {
  let case = one_deposit()
  let out = out_datum(case)
  expect [root, ..roots] = out.roots
  expect
    validate(
      with_out(
        case,
        PoolDatum { ..out, roots: [root + groth16.fr_order, ..roots] },
      ),
    )
  True
}

test pool_i8_start_size_plus_r() fail {
  expect validate(with_size(one_deposit(), groth16.fr_order))
  True
}

test pool_i8_queue_commitment_plus_r() fail {
  let case = one_note()
  expect [commitment] = case.datum.queue
  expect
    validate(
      with_datum(
        case,
        PoolDatum { ..case.datum, queue: [commitment + groth16.fr_order] },
      ),
    )
  True
}

test pool_i9_changed_proof_byte() fail {
  let case = one_deposit()
  let a = builtin.append_bytearray(
    builtin.slice_bytearray(0, 47, case.proof.a),
    builtin.cons_bytearray(
      ( builtin.index_bytearray(case.proof.a, 47) + 1 ) % 256,
      #"",
    ),
  )
  expect validate(Case { ..case, proof: groth16.Proof { ..case.proof, a } })
  True
}

test pool_i9_another_scenario_proof() fail {
  let case = one_deposit()
  expect validate(Case { ..case, proof: f.one_note_proof })
  True
}

test pool_i10_keeps_flushed_queue_entry() fail {
  let case = four_notes()
  expect [_, _, _, fourth, fifth] = case.datum.queue
  expect
    validate(
      with_out(case, PoolDatum { ..out_datum(case), queue: [fourth, fifth] }),
    )
  True
}

test pool_i10_drops_extra_queue_entry() fail {
  let case = four_notes()
  expect validate(with_out(case, PoolDatum { ..out_datum(case), queue: [] }))
  True
}

test pool_i10_seventeen_roots() fail {
  let case = four_notes()
  let out = out_datum(case)
  let root = list.expect_head(out.roots)
  expect
    validate(
      with_out(case, PoolDatum { ..out, roots: [root, ..case.datum.roots] }),
    )
  True
}

test pool_i10_wrong_root_history() fail {
  let case = one_deposit()
  let out = out_datum(case)
  expect [root, old] = out.roots
  expect validate(with_out(case, PoolDatum { ..out, roots: [root, old + 1] }))
  True
}

test pool_i10_wrong_size() fail {
  let case = one_deposit()
  let out = out_datum(case)
  expect validate(with_out(case, PoolDatum { ..out, size: out.size + 1 }))
  True
}

test pool_i10_wrong_accrued_fees() fail {
  let case = fee_bps()
  let out = out_datum(case)
  expect
    validate(
      with_out(case, PoolDatum { ..out, fees_accrued: out.fees_accrued + 1 }),
    )
  True
}

test pool_i10_changed_nullifier_root() fail {
  let case = one_deposit()
  expect
    validate(
      with_out(
        case,
        PoolDatum {
          ..out_datum(case),
          nullifier_root: testkit.output_reference_1.transaction_id,
        },
      ),
    )
  True
}

test pool_i11_balance_one_more() fail {
  expect validate(with_balance_delta(one_deposit(), 1))
  True
}

test pool_i11_balance_one_less() fail {
  expect validate(with_balance_delta(one_deposit(), -1))
  True
}

test pool_i12_cap_exceeded() fail {
  expect
    validate(
      with_config(
        one_deposit(),
        ConfigDatum {
          ..kit.m0_config(),
          pool_cap: f.one_deposit_balance_out - 1,
        },
      ),
    )
  True
}

test pool_i12_notes_pass_above_cap() {
  validate(
    with_config(
      one_note(),
      ConfigDatum { ..kit.m0_config(), pool_cap: f.one_note_balance_out - 1 },
    ),
  )
}

test pool_i12_at_cap() {
  validate(
    with_config(
      one_deposit(),
      ConfigDatum { ..kit.m0_config(), pool_cap: f.one_deposit_balance_out },
    ),
  )
}

test pool_i12_cap_excludes_fees() {
  validate(
    with_config(
      fee_bps(),
      ConfigDatum {
        ..f.fee_bps_config,
        pool_cap: f.fee_bps_balance_out - f.fee_bps_out_datum.fees_accrued,
      },
    ),
  )
}

test pool_i0_deposits_leave_unflushed_queue() {
  let case = four_deposits()
  validate(
    with_out(
      with_datum(case, PoolDatum { ..case.datum, queue: [42] }),
      PoolDatum { ..out_datum(case), queue: [42] },
    ),
  )
}

test pool_i0_deposit_with_stake_credential() {
  validate(
    with_deposit(
      one_deposit(),
      fn(input) {
        Input {
          ..input,
          output: Output {
            ..input.output,
            address: address.with_delegation_key(
              input.output.address,
              testkit.key_hash_4,
            ),
          },
        }
      },
    ),
  )
}

test pool_i0_token_pool_credits_asset_without_crank_deduction() {
  let case = one_deposit()
  let asset = AssetClass { policy: testkit.script_hash_1, name: "token" }
  expect [own, deposit] = case.tx.inputs
  expect [continuing] = case.tx.outputs
  let own = Input {
    ..own,
    output: Output {
      ..own.output,
      value: assets.add(
        own.output.value,
        asset.policy,
        asset.name,
        f.one_deposit_balance_in,
      ),
    },
  }
  // Reuse the proof's 9.7M credit with 9.7M tokens and unrelated deposit ADA.
  let deposit = Input {
    ..deposit,
    output: Output {
      ..deposit.output,
      value: assets.from_lovelace(2_000_000)
        |> assets.add(asset.policy, asset.name, 9_700_000),
    },
  }
  let continuing = Output {
    ..continuing,
    value: assets.add(own.output.value, asset.policy, asset.name, 9_700_000),
  }
  validate(
    Case {
      ..case,
      params: PoolParams { ..case.params, asset },
      tx: Transaction {
        ..case.tx,
        inputs: [own, deposit],
        outputs: [continuing],
      },
    },
  )
}
