use aiken/builtin
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/merkle_patricia_forestry as mpf
use cardano/address
use cardano/assets
use cardano/transaction.{Output, OutputReference, Transaction}
use zbase/constants
use zbase/fixtures/common
use zbase/fixtures/ragequit as fixture
use zbase/groth16.{Proof}
use zbase/pool
use zbase/pool/kit
use zbase/testkit
use zbase/types.{ConfigDatum, DepositDatum, PoolDatum, Ragequit}

// A single-constructor record lets each negative case change one rule's input.
type Exit {
  datum: PoolDatum,
  out_datum: PoolDatum,
  proof: Proof,
  nullifier_hash: Int,
  value: Int,
  state_root: Int,
  deposit_ref: OutputReference,
  refund: VerificationKeyHash,
  nullifier_proof: mpf.Proof,
}

fn deposit_note() -> Exit {
  Exit {
    datum: fixture.deposit_note_datum,
    out_datum: fixture.deposit_note_out_datum,
    proof: fixture.deposit_note_proof,
    nullifier_hash: fixture.deposit_note_nullifier_hash,
    value: fixture.deposit_note_value,
    state_root: fixture.deposit_note_state_root,
    deposit_ref: fixture.deposit_note_deposit_ref,
    refund: fixture.deposit_note_refund,
    nullifier_proof: fixture.deposit_note_trie_proof,
  }
}

fn change_note() -> Exit {
  Exit {
    datum: fixture.change_note_datum,
    out_datum: fixture.change_note_out_datum,
    proof: fixture.change_note_proof,
    nullifier_hash: fixture.change_note_nullifier_hash,
    value: fixture.change_note_value,
    state_root: fixture.change_note_state_root,
    deposit_ref: fixture.change_note_deposit_ref,
    refund: fixture.change_note_refund,
    nullifier_proof: fixture.change_note_trie_proof,
  }
}

fn transaction(exit: Exit) -> Transaction {
  testkit.transaction(
    [kit.pool_input(exit.datum, 40_000_000)],
    [kit.config_ref(kit.m0_config())],
    [
      kit.pool_output(exit.out_datum, 40_000_000 - exit.value),
      // The depositor may choose a destination different from the refund key.
      testkit.output(
        address.from_verification_key(testkit.key_hash_3),
        assets.from_lovelace(exit.value),
        Void,
      ),
    ],
    assets.zero,
    [fixture.deposit_note_refund, testkit.key_hash_2],
    interval.everything,
  )
}

fn validate(exit: Exit, tx: Transaction) -> Bool {
  pool.validate(
    kit.params(kit.placeholder_key, kit.placeholder_key, common.vk_ragequit),
    Some(exit.datum),
    Ragequit {
      proof: exit.proof,
      nullifier_hash: exit.nullifier_hash,
      value: exit.value,
      state_root: exit.state_root,
      deposit_ref: exit.deposit_ref,
      refund: exit.refund,
      nullifier_proof: exit.nullifier_proof,
    },
    kit.pool_ref,
    tx,
  )
}

fn adjust_balance(tx: Transaction, delta: Int) -> Transaction {
  expect [continuing, ..outputs] = tx.outputs
  Transaction {
    ..tx,
    outputs: [
      Output {
        ..continuing,
        value: assets.add(continuing.value, "", "", delta),
      },
      ..outputs
    ],
  }
}

test pool_r0_deposit_note_without_asp() {
  let exit = deposit_note()
  let tx = transaction(exit)
  expect tx.reference_inputs == [kit.config_ref(kit.m0_config())]
  validate(exit, tx)
}

test pool_r0_change_note_without_asp() {
  let exit = change_note()
  let tx = transaction(exit)
  expect tx.reference_inputs == [kit.config_ref(kit.m0_config())]
  validate(exit, tx)
}

test bud_04_deposit_note() {
  let exit = deposit_note()
  validate(exit, transaction(exit))
}

test pool_r0_paused_deposits_and_fees_do_not_block_exit() {
  let exit = deposit_note()
  let tx = transaction(exit)
  let config = ConfigDatum {
    ..kit.m0_config(),
    deposits_paused: True,
    settle_fee_bps: constants.max_settle_fee_bps,
    crank_fee: constants.max_crank_fee,
  }
  validate(
    exit,
    Transaction { ..tx, reference_inputs: [kit.config_ref(config)] },
  )
}

test pool_r1_dep_03_deposit_input() fail {
  let exit = deposit_note()
  let tx = transaction(exit)
  let deposit = testkit.input(
    testkit.output_reference_3,
    testkit.output(
      address.from_script(kit.deposit_script),
      assets.from_lovelace(5_000_000),
      DepositDatum { precommitment: 42, refund: exit.refund },
    ),
  )
  expect validate(exit, Transaction { ..tx, inputs: [deposit, ..tx.inputs] })
  True
}

test pool_r2_state_root_missing() fail {
  let base = deposit_note()
  // Keep input and output history equal so only membership is invalid.
  let roots = [base.state_root + 1]
  let exit = Exit {
    ..base,
    datum: PoolDatum { ..base.datum, roots },
    out_datum: PoolDatum { ..base.out_datum, roots },
  }
  expect validate(exit, transaction(exit))
  True
}

test pool_r3_missing_refund_signature() fail {
  let exit = deposit_note()
  let tx = transaction(exit)
  expect validate(exit, Transaction { ..tx, extra_signatories: [] })
  True
}

test pool_r3_another_key_signed() fail {
  let exit = deposit_note()
  let tx = transaction(exit)
  expect
    validate(
      exit,
      Transaction { ..tx, extra_signatories: [testkit.key_hash_2] },
    )
  True
}

test pool_r3_deposit_reference_changed() fail {
  let base = deposit_note()
  let exit = Exit {
    ..base,
    deposit_ref: OutputReference { ..base.deposit_ref, output_index: 3 },
  }
  expect validate(exit, transaction(base))
  True
}

test pool_r3_refund_changed_to_another_signer() fail {
  let base = deposit_note()
  let exit = Exit { ..base, refund: testkit.key_hash_2 }
  expect validate(exit, transaction(base))
  True
}

test pool_r4_zero_value() fail {
  let base = deposit_note()
  expect validate(Exit { ..base, value: 0 }, transaction(base))
  True
}

test pool_r4_value_at_two_to_64() fail {
  let base = deposit_note()
  expect
    validate(Exit { ..base, value: constants.max_value + 1 }, transaction(base))
  True
}

test pool_r4_nullifier_alias() fail {
  let base = deposit_note()
  let exit = Exit {
    ..base,
    nullifier_hash: fixture.alias_nullifier_hash,
    nullifier_proof: fixture.alias_trie_proof,
    out_datum: fixture.alias_out_datum,
  }
  expect validate(exit, transaction(exit))
  True
}

test pool_r5_one_proof_byte_changed() fail {
  let base = deposit_note()
  let first = builtin.index_bytearray(base.proof.a, 0)
  // Toggle only the sign bit, preserving a valid compressed curve point.
  let flipped = if first >= 160 {
    first - 32
  } else {
    first + 32
  }
  let proof = Proof {
    ..base.proof,
    a: builtin.cons_bytearray(
      flipped,
      builtin.slice_bytearray(1, 47, base.proof.a),
    ),
  }
  expect validate(Exit { ..base, proof }, transaction(base))
  True
}

test pool_r5_value_raised_with_matching_balance() fail {
  let base = deposit_note()
  let exit = Exit { ..base, value: base.value + 1 }
  expect validate(exit, transaction(exit))
  True
}

test pool_r6_nullifier_already_spent() fail {
  let base = deposit_note()
  let exit = Exit {
    ..base,
    datum: PoolDatum {
      ..base.datum,
      nullifier_root: base.out_datum.nullifier_root,
    },
  }
  expect validate(exit, transaction(exit))
  True
}

test pool_r7_balance_falls_one_more() fail {
  let exit = deposit_note()
  expect validate(exit, adjust_balance(transaction(exit), -1))
  True
}

test pool_r7_balance_falls_one_less() fail {
  let exit = deposit_note()
  expect validate(exit, adjust_balance(transaction(exit), 1))
  True
}

test pool_r8_roots_changed() fail {
  let exit = deposit_note()
  expect
    validate(
      exit,
      kit.with_out_datum(
        transaction(exit),
        PoolDatum { ..exit.out_datum, roots: [exit.state_root + 1] },
      ),
    )
  True
}

test pool_r8_size_changed() fail {
  let exit = deposit_note()
  expect
    validate(
      exit,
      kit.with_out_datum(
        transaction(exit),
        PoolDatum { ..exit.out_datum, size: exit.out_datum.size + 1 },
      ),
    )
  True
}

test pool_r8_queue_changed() fail {
  let exit = deposit_note()
  expect
    validate(
      exit,
      kit.with_out_datum(
        transaction(exit),
        PoolDatum { ..exit.out_datum, queue: [] },
      ),
    )
  True
}

test pool_r8_fees_accrued_changed() fail {
  let exit = deposit_note()
  expect
    validate(
      exit,
      kit.with_out_datum(
        transaction(exit),
        PoolDatum {
          ..exit.out_datum,
          fees_accrued: exit.out_datum.fees_accrued + 1,
        },
      ),
    )
  True
}
