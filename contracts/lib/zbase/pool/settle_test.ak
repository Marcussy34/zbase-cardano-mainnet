use aiken/builtin
use aiken/collection/list
use aiken/interval
use aiken/merkle_patricia_forestry as mpf
use cardano/address
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, Transaction,
}
use zbase/constants
use zbase/encoding
use zbase/fixtures/common as fixture_keys
use zbase/fixtures/settle as fixtures
use zbase/groth16
use zbase/pool
use zbase/pool/common.{PoolParams}
use zbase/pool/kit
use zbase/testkit
use zbase/types.{
  AssetClass, ConfigDatum, DepositDatum, Payout, PoolDatum, Settle, SettleIntent,
}

// A case holds data only. All acceptance decisions go through pool.validate.
type Case {
  datum: PoolDatum,
  tx: Transaction,
  proof: groth16.Proof,
  nullifier_hash: Int,
  new_commitment: Int,
  withdrawn: Int,
  state_root: Int,
  intent: SettleIntent,
  nullifier_proof: mpf.Proof,
}

fn payout_output(payout: Payout) -> Output {
  Output {
    address: payout.address,
    value: assets.from_lovelace(payout.amount),
    datum: when payout.datum_hash is {
      None -> NoDatum
      Some(_) -> InlineDatum(fixtures.payout_datum)
    },
    reference_script: None,
  }
}

fn transaction(
  datum: PoolDatum,
  out: PoolDatum,
  config: ConfigDatum,
  asp: Int,
  intent: SettleIntent,
  balance_in: Int,
  balance_out: Int,
) -> Transaction {
  testkit.transaction(
    [kit.pool_input(datum, balance_in)],
    [kit.config_ref(config), kit.asp_ref(asp)],
    [
      kit.pool_output(out, balance_out),
      ..list.map(intent.payouts, payout_output)
    ],
    assets.zero,
    [testkit.key_hash_1],
    interval.before(intent.valid_until),
  )
}

fn params() -> PoolParams {
  kit.params(fixture_keys.vk_spend, kit.placeholder_key, kit.placeholder_key)
}

fn validate_with(case: Case, params: PoolParams) -> Bool {
  pool.validate(
    params,
    Some(case.datum),
    Settle {
      proof: case.proof,
      nullifier_hash: case.nullifier_hash,
      new_commitment: case.new_commitment,
      withdrawn: case.withdrawn,
      state_root: case.state_root,
      intent: case.intent,
      nullifier_proof: case.nullifier_proof,
    },
    kit.pool_ref,
    case.tx,
  )
}

fn validate(case: Case) -> Bool {
  validate_with(case, params())
}

// Mutate one logical starting datum while preserving the input's inline copy.
fn with_datum(case: Case, datum: PoolDatum) -> Case {
  expect [own] = case.tx.inputs
  let output = Output { ..own.output, datum: InlineDatum(datum) }
  Case {
    ..case,
    datum,
    tx: Transaction { ..case.tx, inputs: [Input { ..own, output }] },
  }
}

fn with_payout(case: Case, index: Int, update: fn(Output) -> Output) -> Case {
  Case {
    ..case,
    tx: Transaction {
      ..case.tx,
      outputs: list.indexed_map(
        case.tx.outputs,
        fn(i, output) {
          if i == index + 1 {
            update(output)
          } else {
            output
          }
        },
      ),
    },
  }
}

fn with_balance(case: Case, delta: Int) -> Case {
  expect [continuing, ..outputs] = case.tx.outputs
  let continuing = Output {
    ..continuing,
    value: assets.add(continuing.value, "", "", delta),
  }
  Case {
    ..case,
    tx: Transaction { ..case.tx, outputs: [continuing, ..outputs] },
  }
}

fn with_config(case: Case, config: ConfigDatum) -> Case {
  expect [_config, asp] = case.tx.reference_inputs
  Case {
    ..case,
    tx: Transaction {
      ..case.tx,
      reference_inputs: [kit.config_ref(config), asp],
    },
  }
}

fn partial() -> Case {
  Case {
    datum: fixtures.partial_datum,
    tx: transaction(
      fixtures.partial_datum,
      fixtures.partial_out_datum,
      fixtures.partial_config,
      fixtures.partial_asp_root,
      fixtures.partial_intent,
      fixtures.partial_balance_in,
      fixtures.partial_balance_out,
    ),
    proof: fixtures.partial_proof,
    nullifier_hash: fixtures.partial_nullifier_hash,
    new_commitment: fixtures.partial_new_commitment,
    withdrawn: fixtures.partial_withdrawn,
    state_root: fixtures.partial_state_root,
    intent: fixtures.partial_intent,
    nullifier_proof: fixtures.partial_trie_proof,
  }
}

fn full() -> Case {
  Case {
    datum: fixtures.full_datum,
    tx: transaction(
      fixtures.full_datum,
      fixtures.full_out_datum,
      fixtures.full_config,
      fixtures.full_asp_root,
      fixtures.full_intent,
      fixtures.full_balance_in,
      fixtures.full_balance_out,
    ),
    proof: fixtures.full_proof,
    nullifier_hash: fixtures.full_nullifier_hash,
    new_commitment: fixtures.full_new_commitment,
    withdrawn: fixtures.full_withdrawn,
    state_root: fixtures.full_state_root,
    intent: fixtures.full_intent,
    nullifier_proof: fixtures.full_trie_proof,
  }
}

fn four_payouts() -> Case {
  Case {
    datum: fixtures.four_payouts_datum,
    tx: transaction(
      fixtures.four_payouts_datum,
      fixtures.four_payouts_out_datum,
      fixtures.four_payouts_config,
      fixtures.four_payouts_asp_root,
      fixtures.four_payouts_intent,
      fixtures.four_payouts_balance_in,
      fixtures.four_payouts_balance_out,
    ),
    proof: fixtures.four_payouts_proof,
    nullifier_hash: fixtures.four_payouts_nullifier_hash,
    new_commitment: fixtures.four_payouts_new_commitment,
    withdrawn: fixtures.four_payouts_withdrawn,
    state_root: fixtures.four_payouts_state_root,
    intent: fixtures.four_payouts_intent,
    nullifier_proof: fixtures.four_payouts_trie_proof,
  }
}

fn zero_withdrawn() -> Case {
  Case {
    datum: fixtures.zero_withdrawn_datum,
    tx: transaction(
      fixtures.zero_withdrawn_datum,
      fixtures.zero_withdrawn_out_datum,
      fixtures.zero_withdrawn_config,
      fixtures.zero_withdrawn_asp_root,
      fixtures.zero_withdrawn_intent,
      fixtures.zero_withdrawn_balance_in,
      fixtures.zero_withdrawn_balance_out,
    ),
    proof: fixtures.zero_withdrawn_proof,
    nullifier_hash: fixtures.zero_withdrawn_nullifier_hash,
    new_commitment: fixtures.zero_withdrawn_new_commitment,
    withdrawn: fixtures.zero_withdrawn_withdrawn,
    state_root: fixtures.zero_withdrawn_state_root,
    intent: fixtures.zero_withdrawn_intent,
    nullifier_proof: fixtures.zero_withdrawn_trie_proof,
  }
}

fn alias() -> Case {
  Case {
    datum: fixtures.alias_datum,
    tx: transaction(
      fixtures.alias_datum,
      fixtures.alias_out_datum,
      fixtures.alias_config,
      fixtures.alias_asp_root,
      fixtures.alias_intent,
      fixtures.alias_balance_in,
      fixtures.alias_balance_out,
    ),
    proof: fixtures.alias_proof,
    nullifier_hash: fixtures.alias_nullifier_hash,
    new_commitment: fixtures.alias_new_commitment,
    withdrawn: fixtures.alias_withdrawn,
    state_root: fixtures.alias_state_root,
    intent: fixtures.alias_intent,
    nullifier_proof: fixtures.alias_trie_proof,
  }
}

fn budget() -> Case {
  Case {
    datum: fixtures.budget_datum,
    tx: transaction(
      fixtures.budget_datum,
      fixtures.budget_out_datum,
      fixtures.budget_config,
      fixtures.budget_asp_root,
      fixtures.budget_intent,
      fixtures.budget_balance_in,
      fixtures.budget_balance_out,
    ),
    proof: fixtures.budget_proof,
    nullifier_hash: fixtures.budget_nullifier_hash,
    new_commitment: fixtures.budget_new_commitment,
    withdrawn: fixtures.budget_withdrawn,
    state_root: fixtures.budget_state_root,
    intent: fixtures.budget_intent,
    nullifier_proof: fixtures.budget_trie_proof,
  }
}

test pool_s0_partial() {
  validate(partial())
}

test pool_s0_full() {
  validate(full())
}

test pool_s0_four_payouts() {
  validate(four_payouts())
}

test bud_01_settle_five_level_trie() {
  validate(budget())
}

test pool_s1_dep_03_deposit_input() fail {
  let base = partial()
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
      Case {
        ..base,
        tx: Transaction { ..base.tx, inputs: [deposit, ..base.tx.inputs] },
      },
    )
  True
}

test pool_s2_state_root_missing() fail {
  let base = partial()
  let changed = with_datum(base, PoolDatum { ..base.datum, roots: [42] })
  expect
    validate(
      Case {
        ..changed,
        tx: kit.with_out_datum(
          changed.tx,
          PoolDatum { ..fixtures.partial_out_datum, roots: [42] },
        ),
      },
    )
  True
}

test pool_s2_oldest_of_sixteen_roots() {
  let base = partial()
  let roots = list.concat(list.range(1, 15), [base.state_root])
  let changed = with_datum(base, PoolDatum { ..base.datum, roots })
  validate(
    Case {
      ..changed,
      tx: kit.with_out_datum(
        changed.tx,
        PoolDatum { ..fixtures.partial_out_datum, roots },
      ),
    },
  )
}

test pool_s3_missing_asp() fail {
  let base = partial()
  expect [config, _asp] = base.tx.reference_inputs
  expect
    validate(
      Case { ..base, tx: Transaction { ..base.tx, reference_inputs: [config] } },
    )
  True
}

test pool_s3_wrong_asp_policy() fail {
  let base = partial()
  expect [config, asp] = base.tx.reference_inputs
  let output = Output {
    ..asp.output,
    value: assets.from_lovelace(2_000_000)
      |> assets.add(testkit.script_hash_1, constants.asp_nft_name, 1),
  }
  expect
    validate(
      Case {
        ..base,
        tx: Transaction {
          ..base.tx,
          reference_inputs: [config, Input { ..asp, output }],
        },
      },
    )
  True
}

test pool_s3_wrong_asp_root() fail {
  let base = partial()
  expect [config, _asp] = base.tx.reference_inputs
  expect
    validate(
      Case {
        ..base,
        tx: Transaction {
          ..base.tx,
          reference_inputs: [config, kit.asp_ref(fixtures.partial_asp_root + 1)],
        },
      },
    )
  True
}

test pool_s4_zero_withdrawn() fail {
  expect validate(zero_withdrawn())
  True
}

test pool_s4_alias() fail {
  expect validate(alias())
  True
}

test pool_s4_zero_commitment() fail {
  let base = partial()
  expect validate(Case { ..base, new_commitment: 0 })
  True
}

test pool_s4_withdrawn_u64() fail {
  let base = partial()
  expect validate(Case { ..base, withdrawn: 18446744073709551616 })
  True
}

test pool_s4_negative_withdrawn() fail {
  let base = partial()
  expect validate(Case { ..base, withdrawn: -1 })
  True
}

test pool_s5_wrong_pool() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        intent: SettleIntent { ..base.intent, pool_id: testkit.script_hash_1 },
      },
    )
  True
}

test pool_s5_empty_payouts() fail {
  let base = partial()
  expect
    validate(
      Case { ..base, intent: SettleIntent { ..base.intent, payouts: [] } },
    )
  True
}

test pool_s5_five_payouts() fail {
  let base = four_payouts()
  let payouts = [list.expect_head(base.intent.payouts), ..base.intent.payouts]
  expect
    validate(Case { ..base, intent: SettleIntent { ..base.intent, payouts } })
  True
}

test pool_s6_changed_amount() fail {
  let base = partial()
  expect [payout] = base.intent.payouts
  let intent = SettleIntent {
    ..base.intent,
    payouts: [Payout { ..payout, amount: payout.amount - 1 }],
  }
  expect validate(Case { ..base, intent })
  True
}

test pool_s6_changed_amount_matching_output() fail {
  let base = partial()
  expect [payout] = base.intent.payouts
  let payout = Payout { ..payout, amount: payout.amount - 1 }
  let changed = with_payout(base, 0, fn(_) { payout_output(payout) })
  expect
    validate(
      Case {
        ..changed,
        intent: SettleIntent { ..base.intent, payouts: [payout] },
      },
    )
  True
}

test pool_s6_changed_address() fail {
  let base = partial()
  expect [payout] = base.intent.payouts
  let intent = SettleIntent {
    ..base.intent,
    payouts: [Payout { ..payout, address: kit.treasury_address }],
  }
  expect validate(Case { ..base, intent })
  True
}

test pool_s6_changed_address_matching_output() fail {
  let base = partial()
  expect [payout] = base.intent.payouts
  let payout = Payout { ..payout, address: kit.treasury_address }
  let changed = with_payout(base, 0, fn(_) { payout_output(payout) })
  expect
    validate(
      Case {
        ..changed,
        intent: SettleIntent { ..base.intent, payouts: [payout] },
      },
    )
  True
}

test pool_s6_changed_expiry() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        intent: SettleIntent {
          ..base.intent,
          valid_until: base.intent.valid_until + 1,
        },
      },
    )
  True
}

test pool_s6_changed_relayer() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        intent: SettleIntent {
          ..base.intent,
          relayer: Some(testkit.key_hash_1),
        },
      },
    )
  True
}

test pool_s7_changed_proof_byte() fail {
  let base = partial()
  let a = builtin.cons_bytearray(
    builtin.index_bytearray(base.proof.a, 0) % 128,
    builtin.slice_bytearray(1, 47, base.proof.a),
  )
  expect validate(Case { ..base, proof: groth16.Proof { ..base.proof, a } })
  True
}

test pool_s7_other_proof() fail {
  let base = partial()
  expect validate(Case { ..base, proof: fixtures.full_proof })
  True
}

test pool_s8_already_spent() fail {
  let base = partial()
  expect
    validate(
      with_datum(
        base,
        PoolDatum {
          ..base.datum,
          nullifier_root: fixtures.partial_out_datum.nullifier_root,
        },
      ),
    )
  True
}

test pool_s8_wrong_trie_proof() fail {
  let base = budget()
  expect
    validate(Case { ..base, nullifier_proof: fixtures.other_key_trie_proof })
  True
}

test pool_s9_full_queue() fail {
  let base = partial()
  let queue = list.range(101, 108)
  let changed = with_datum(base, PoolDatum { ..base.datum, queue })
  expect
    validate(
      Case {
        ..changed,
        tx: kit.with_out_datum(
          changed.tx,
          PoolDatum {
            ..fixtures.partial_out_datum,
            queue: list.concat(queue, [base.new_commitment]),
          },
        ),
      },
    )
  True
}

test pool_s9_missing_commitment() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        tx: kit.with_out_datum(
          base.tx,
          PoolDatum { ..fixtures.partial_out_datum, queue: base.datum.queue },
        ),
      },
    )
  True
}

test pool_s9_commitment_at_front() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        tx: kit.with_out_datum(
          base.tx,
          PoolDatum {
            ..fixtures.partial_out_datum,
            queue: [base.new_commitment, ..base.datum.queue],
          },
        ),
      },
    )
  True
}

test pool_s10_wrong_address() fail {
  expect
    validate(
      with_payout(
        partial(),
        0,
        fn(output) { Output { ..output, address: kit.treasury_address } },
      ),
    )
  True
}

test pool_s10_one_less() fail {
  expect
    validate(
      with_payout(
        partial(),
        0,
        fn(output) {
          Output { ..output, value: assets.add(output.value, "", "", -1) }
        },
      ),
    )
  True
}

test pool_s10_one_more() fail {
  expect
    validate(
      with_payout(
        partial(),
        0,
        fn(output) {
          Output { ..output, value: assets.add(output.value, "", "", 1) }
        },
      ),
    )
  True
}

test pool_s10_foreign_token() fail {
  expect
    validate(
      with_payout(
        partial(),
        0,
        fn(output) {
          Output {
            ..output,
            value: assets.add(output.value, testkit.script_hash_1, "token", 1),
          }
        },
      ),
    )
  True
}

test pool_s10_unexpected_datum() fail {
  expect
    validate(
      with_payout(
        partial(),
        0,
        fn(output) { Output { ..output, datum: InlineDatum(42) } },
      ),
    )
  True
}

test pool_s10_reference_script() fail {
  expect
    validate(
      with_payout(
        partial(),
        0,
        fn(output) {
          Output { ..output, reference_script: Some(testkit.script_hash_1) }
        },
      ),
    )
  True
}

test pool_s10_wrong_datum() fail {
  expect
    validate(
      with_payout(
        four_payouts(),
        2,
        fn(output) { Output { ..output, datum: InlineDatum(43) } },
      ),
    )
  True
}

test pool_s10_datum_hash_not_inline() fail {
  expect
    validate(
      with_payout(
        four_payouts(),
        2,
        fn(output) {
          Output { ..output, datum: DatumHash(fixtures.payout_datum_hash) }
        },
      ),
    )
  True
}

test pool_s10_missing_datum() fail {
  expect
    validate(
      with_payout(
        four_payouts(),
        2,
        fn(output) { Output { ..output, datum: NoDatum } },
      ),
    )
  True
}

test pool_s10_swapped_outputs() fail {
  let base = four_payouts()
  expect [continuing, first, second, ..rest] = base.tx.outputs
  expect
    validate(
      Case {
        ..base,
        tx: Transaction {
          ..base.tx,
          outputs: [continuing, second, first, ..rest],
        },
      },
    )
  True
}

test pool_s10_missing_output() fail {
  let base = partial()
  expect [continuing, _payout] = base.tx.outputs
  expect
    validate(
      Case { ..base, tx: Transaction { ..base.tx, outputs: [continuing] } },
    )
  True
}

test pool_s11_exact_paid_plus_fee() {
  expect
    fixtures.four_payouts_withdrawn == fixtures.four_payouts_paid + fixtures.four_payouts_fee
  validate(four_payouts())
}

test pool_s11_fee_exceeds_withdrawn() fail {
  let base = four_payouts()
  expect
    validate(
      with_config(
        base,
        ConfigDatum { ..fixtures.four_payouts_config, settle_fee_bps: 101 },
      ),
    )
  True
}

test pool_s11_fee_exceeds_with_matching_accounting() fail {
  let base = with_config(
    four_payouts(),
    ConfigDatum { ..fixtures.four_payouts_config, settle_fee_bps: 101 },
  )
  let changed = with_balance(base, 800)
  expect
    validate(
      Case {
        ..changed,
        tx: kit.with_out_datum(
          changed.tx,
          PoolDatum {
            ..fixtures.four_payouts_out_datum,
            fees_accrued: fixtures.four_payouts_out_datum.fees_accrued + 800,
          },
        ),
      },
    )
  True
}

test pool_s12_balance_falls_one_more() fail {
  expect validate(with_balance(partial(), -1))
  True
}

test pool_s12_balance_falls_one_less() fail {
  expect validate(with_balance(partial(), 1))
  True
}

test pool_s12_wrong_fees() fail {
  let base = four_payouts()
  expect
    validate(
      Case {
        ..base,
        tx: kit.with_out_datum(
          base.tx,
          PoolDatum {
            ..fixtures.four_payouts_out_datum,
            fees_accrued: fixtures.four_payouts_out_datum.fees_accrued + 1,
          },
        ),
      },
    )
  True
}

test pool_s13_no_upper_bound() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        tx: Transaction { ..base.tx, validity_range: interval.everything },
      },
    )
  True
}

test pool_s13_late_upper_bound() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        tx: Transaction {
          ..base.tx,
          validity_range: interval.before(base.intent.valid_until + 1),
        },
      },
    )
  True
}

test pool_s13_late_exclusive_upper_bound() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        tx: Transaction {
          ..base.tx,
          validity_range: interval.entirely_before(base.intent.valid_until + 1),
        },
      },
    )
  True
}

test pool_s13_upper_bound_equal() {
  validate(partial())
}

test pool_s14_missing_signature() fail {
  let base = full()
  expect
    validate(
      Case { ..base, tx: Transaction { ..base.tx, extra_signatories: [] } },
    )
  True
}

test pool_s14_wrong_signature() fail {
  let base = full()
  expect
    validate(
      Case {
        ..base,
        tx: Transaction { ..base.tx, extra_signatories: [testkit.key_hash_2] },
      },
    )
  True
}

test pool_s15_changed_roots() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        tx: kit.with_out_datum(
          base.tx,
          PoolDatum { ..fixtures.partial_out_datum, roots: [42] },
        ),
      },
    )
  True
}

test pool_s15_changed_size() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        tx: kit.with_out_datum(
          base.tx,
          PoolDatum {
            ..fixtures.partial_out_datum,
            size: fixtures.partial_out_datum.size + 1,
          },
        ),
      },
    )
  True
}

test pool_s15_changed_nullifier_root() fail {
  let base = partial()
  expect
    validate(
      Case {
        ..base,
        tx: kit.with_out_datum(
          base.tx,
          PoolDatum {
            ..fixtures.partial_out_datum,
            nullifier_root: fixtures.partial_datum.nullifier_root,
          },
        ),
      },
    )
  True
}

test pool_s4_zero_fixture_has_valid_proof() {
  groth16.verify(
    fixture_keys.vk_spend,
    fixtures.zero_withdrawn_proof,
    fixtures.zero_withdrawn_public_inputs,
  )
}

test pool_s4_alias_has_matching_trie_transition() {
  // Verify the raw trie transition without common.nullifier_insert's field guard.
  let root = mpf.from_root(fixtures.alias_datum.nullifier_root)
    |> mpf.insert(
        encoding.nullifier_key(fixtures.alias_nullifier_hash),
        #"01",
        fixtures.alias_trie_proof,
      )
    |> mpf.root
  and {
    fixtures.alias_nullifier_hash == fixtures.partial_nullifier_hash + groth16.fr_order,
    fixtures.alias_proof == fixtures.partial_proof,
    root == fixtures.alias_out_datum.nullifier_root,
  }
}

test pool_s0_full_change_is_zero() {
  fixtures.full_change_value == 0 && fixtures.full_new_commitment != 0
}

test pool_s10_datum_hash_matches() {
  let datum: Data = fixtures.payout_datum
  builtin.blake2b_256(builtin.serialise_data(datum)) == fixtures.payout_datum_hash
}

// Reuse the valid note amounts as token units; the circuit is asset-independent.
fn token_case() -> Case {
  let base = partial()
  expect [own] = base.tx.inputs
  expect [continuing, payout] = base.tx.outputs
  let output = Output {
    ..own.output,
    value: assets.from_lovelace(6_000_000)
      |> assets.add(kit.nft_policy, constants.pool_nft_name, 1)
      |> assets.add(testkit.script_hash_1, "token", fixtures.partial_balance_in),
  }
  let continuing = Output {
    ..continuing,
    value: assets.from_lovelace(6_000_000)
      |> assets.add(kit.nft_policy, constants.pool_nft_name, 1)
      |> assets.add(
          testkit.script_hash_1,
          "token",
          fixtures.partial_balance_out,
        ),
  }
  let payout = Output {
    ..payout,
    value: assets.from_lovelace(2_000_000)
      |> assets.add(testkit.script_hash_1, "token", fixtures.partial_paid),
  }
  Case {
    ..base,
    tx: Transaction {
      ..base.tx,
      inputs: [Input { ..own, output }],
      outputs: [continuing, payout],
    },
  }
}

fn token_params() -> PoolParams {
  PoolParams {
    ..params(),
    asset: AssetClass { policy: testkit.script_hash_1, name: "token" },
  }
}

test pool_s10_token_pool() {
  validate_with(token_case(), token_params())
}

test pool_s10_token_pool_any_lovelace() {
  validate_with(
    with_payout(
      token_case(),
      0,
      fn(output) {
        Output { ..output, value: assets.add(output.value, "", "", 1_000_000) }
      },
    ),
    token_params(),
  )
}

test pool_s10_token_foreign_name() fail {
  expect
    validate_with(
      with_payout(
        token_case(),
        0,
        fn(output) {
          Output {
            ..output,
            value: assets.add(output.value, testkit.script_hash_1, "other", 1),
          }
        },
      ),
      token_params(),
    )
  True
}

test pool_s10_token_foreign_policy() fail {
  expect
    validate_with(
      with_payout(
        token_case(),
        0,
        fn(output) {
          Output {
            ..output,
            value: assets.add(output.value, testkit.script_hash_2, "token", 1),
          }
        },
      ),
      token_params(),
    )
  True
}

test pool_s10_token_wrong_amount() fail {
  expect
    validate_with(
      with_payout(
        token_case(),
        0,
        fn(output) {
          Output {
            ..output,
            value: assets.add(output.value, testkit.script_hash_1, "token", -1),
          }
        },
      ),
      token_params(),
    )
  True
}
