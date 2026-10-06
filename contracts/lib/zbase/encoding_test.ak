//// Public fixtures copied from docs/vectors/encoding-vectors.json.
//// Each rejection changes one field of a valid fixture.

use aiken/builtin
use aiken/collection/list
use cardano/address.{Address, Inline, Pointer, Script, VerificationKey}
use cardano/transaction.{OutputReference}
use zbase/encoding.{context, intent_bytes, label, nullifier_key}
use zbase/types.{Payout, SettleIntent}

const pool_id = #"11111111111111111111111111111111111111111111111111111111"

const refund = #"33333333333333333333333333333333333333333333333333333333"

fn deposit_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
    output_index: 1,
  }
}

fn key_payout() -> Payout {
  Payout {
    address: Address {
      payment_credential: VerificationKey(
        #"44444444444444444444444444444444444444444444444444444444",
      ),
      stake_credential: None,
    },
    amount: 5_000_000,
    datum_hash: None,
  }
}

fn script_payout() -> Payout {
  Payout {
    address: Address {
      payment_credential: Script(
        #"55555555555555555555555555555555555555555555555555555555",
      ),
      stake_credential: Some(
        Inline(
          VerificationKey(
            #"66666666666666666666666666666666666666666666666666666666",
          ),
        ),
      ),
    },
    amount: 12_345_678,
    datum_hash: Some(
      #"7777777777777777777777777777777777777777777777777777777777777777",
    ),
  }
}

fn context_1() -> SettleIntent {
  SettleIntent {
    pool_id,
    payouts: [key_payout()],
    relayer: None,
    valid_until: 1_790_000_000_000,
  }
}

fn context_2() -> SettleIntent {
  SettleIntent {
    pool_id,
    payouts: [script_payout(), Payout { ..key_payout(), amount: 1_000_000 }],
    relayer: Some(#"88888888888888888888888888888888888888888888888888888888"),
    valid_until: 1_790_000_600_000,
  }
}

test enc_01_label_1() {
  label(pool_id, deposit_ref(), refund) == 365182678302074080322242156994707803105708113109831335789927551073021292182
}

test enc_01_label_2() {
  label(
    pool_id,
    OutputReference {
      transaction_id: #"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      output_index: 0,
    },
    #"6465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f",
  ) == 246934600626355260733636012961420319167701563747586671576879507582575895468
}

test enc_02_context_1_bytes() {
  intent_bytes(context_1()) == #"7a626173652f696e74656e742f7631111111111111111111111111111111111111111111111111111111110100444444444444444444444444444444444444444444444444444444440000000000004c4b400000000001a0c4506c00"
}

test enc_02_context_1_hash() {
  context(context_1()) == 292743518427703608824442739660015427555402993442205603038697901196749216898
}

test enc_02_context_2_bytes() {
  intent_bytes(context_2()) == #"7a626173652f696e74656e742f7631111111111111111111111111111111111111111111111111111111110201555555555555555555555555555555555555555555555555555555550100666666666666666666666666666666666666666666666666666666660000000000bc614e01777777777777777777777777777777777777777777777777777777777777777700444444444444444444444444444444444444444444444444444444440000000000000f4240000188888888888888888888888888888888888888888888888888888888000001a0c45993c0"
}

test enc_02_context_2_hash() {
  context(context_2()) == 101308856138185724333200479859797878778269363204375962162379830094954807352
}

test enc_03_nullifier_key_1() {
  nullifier_key(123456789012345678901234567890) == #"00000000000000000000000000000000000000018ee90ff6c373e0ee4e3f0ad2"
}

test enc_03_nullifier_key_2() {
  nullifier_key(
    52435875175126190479447740508185965837690552500527637822603658699938581184512,
  ) == #"73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000000"
}

test enc_04_pointer_stake_fails() fail {
  let payout = key_payout()
  let address = Address {
    ..payout.address,
    stake_credential: Some(
      Pointer { slot_number: 1, transaction_index: 0, certificate_index: 0 },
    ),
  }
  context(
    SettleIntent { ..context_1(), payouts: [Payout { ..payout, address }] },
  ) >= 0
}

test enc_05_amount_overflow_fails() fail {
  let payout = Payout { ..key_payout(), amount: 18446744073709551616 }
  context(SettleIntent { ..context_1(), payouts: [payout] }) >= 0
}

test enc_05_negative_amount_fails() fail {
  let payout = Payout { ..key_payout(), amount: -1 }
  context(SettleIntent { ..context_1(), payouts: [payout] }) >= 0
}

test enc_05_short_datum_hash_fails() fail {
  let payout = Payout {
    ..script_payout(),
    datum_hash: Some(
      #"77777777777777777777777777777777777777777777777777777777777777",
    ),
  }
  context(
    SettleIntent {
      ..context_2(),
      payouts: [payout, Payout { ..key_payout(), amount: 1_000_000 }],
    },
  ) >= 0
}

test enc_05_short_payment_hash_fails() fail {
  let payout = key_payout()
  let address = Address {
    ..payout.address,
    payment_credential: VerificationKey(
      #"444444444444444444444444444444444444444444444444444444",
    ),
  }
  context(
    SettleIntent { ..context_1(), payouts: [Payout { ..payout, address }] },
  ) >= 0
}

test enc_05_long_stake_hash_fails() fail {
  let payout = script_payout()
  let address = Address {
    ..payout.address,
    stake_credential: Some(
      Inline(
        VerificationKey(
          #"6666666666666666666666666666666666666666666666666666666666",
        ),
      ),
    ),
  }
  context(
    SettleIntent {
      ..context_2(),
      payouts: [
        Payout { ..payout, address },
        Payout { ..key_payout(), amount: 1_000_000 },
      ],
    },
  ) >= 0
}

test enc_05_short_relayer_fails() fail {
  context(
    SettleIntent {
      ..context_2(),
      relayer: Some(#"888888888888888888888888888888888888888888888888888888"),
    },
  ) >= 0
}

test enc_05_short_pool_id_fails() fail {
  context(
    SettleIntent {
      ..context_1(),
      pool_id: #"111111111111111111111111111111111111111111111111111111",
    },
  ) >= 0
}

test enc_05_valid_until_overflow_fails() fail {
  context(SettleIntent { ..context_1(), valid_until: 18446744073709551616 }) >= 0
}

test enc_01_output_index_overflow_fails() fail {
  label(
    pool_id,
    OutputReference { ..deposit_ref(), output_index: 4294967296 },
    refund,
  ) >= 0
}

test enc_01_short_pool_id_fails() fail {
  label(
    #"111111111111111111111111111111111111111111111111111111",
    deposit_ref(),
    refund,
  ) >= 0
}

test enc_01_short_transaction_id_fails() fail {
  label(
    pool_id,
    OutputReference {
      ..deposit_ref(),
      transaction_id: #"22222222222222222222222222222222222222222222222222222222222222",
    },
    refund,
  ) >= 0
}

test enc_01_long_refund_hash_fails() fail {
  label(
    pool_id,
    deposit_ref(),
    #"3333333333333333333333333333333333333333333333333333333333",
  ) >= 0
}

test enc_03_negative_nullifier_fails() fail {
  builtin.length_of_bytearray(nullifier_key(-1)) >= 0
}

test enc_03_nullifier_overflow_fails() fail {
  builtin.length_of_bytearray(
    nullifier_key(
      115792089237316195423570985008687907853269984665640564039457584007913129639936,
    ),
  ) >= 0
}

test enc_03_zero_nullifier() {
  nullifier_key(0) == #"0000000000000000000000000000000000000000000000000000000000000000"
}

test enc_02_binds_second_amount() {
  let intent = context_2()
  expect [first, second] = intent.payouts
  let changed = SettleIntent {
    ..intent,
    payouts: [first, Payout { ..second, amount: 1_000_001 }],
  }
  context(changed) != context(intent)
}

test enc_02_binds_relayer() {
  let intent = context_2()
  let changed = SettleIntent { ..intent, relayer: None }
  context(changed) != context(intent)
}

test enc_02_binds_payout_order() {
  let intent = context_2()
  expect [first, second] = intent.payouts
  let changed = SettleIntent { ..intent, payouts: [second, first] }
  context(changed) != context(intent)
}

test enc_02_binds_valid_until() {
  let intent = context_2()
  let changed = SettleIntent { ..intent, valid_until: 1_790_000_600_001 }
  context(changed) != context(intent)
}

test enc_01_negative_output_index_fails() fail {
  label(pool_id, OutputReference { ..deposit_ref(), output_index: -1 }, refund) >= 0
}

test enc_05_negative_valid_until_fails() fail {
  context(SettleIntent { ..context_1(), valid_until: -1 }) >= 0
}

test enc_03_maximum_32_byte_nullifier() {
  nullifier_key(
    115792089237316195423570985008687907853269984665640564039457584007913129639935,
  ) == #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
}

test enc_05_payout_count_overflow_fails() fail {
  context(
    SettleIntent { ..context_1(), payouts: list.repeat(key_payout(), 256) },
  ) >= 0
}

test enc_02_encodes_0_payouts() {
  let bytes = intent_bytes(
    SettleIntent { ..context_1(), payouts: list.repeat(key_payout(), 0) },
  )
  and {
    builtin.length_of_bytearray(bytes) == 53,
    builtin.slice_bytearray(43, 1, bytes) == #"00",
  }
}

test enc_02_encodes_5_payouts() {
  let bytes = intent_bytes(
    SettleIntent { ..context_1(), payouts: list.repeat(key_payout(), 5) },
  )
  and {
    builtin.length_of_bytearray(bytes) == 248,
    builtin.slice_bytearray(43, 1, bytes) == #"05",
  }
}

test enc_02_encodes_255_payouts() {
  let bytes = intent_bytes(
    SettleIntent { ..context_1(), payouts: list.repeat(key_payout(), 255) },
  )
  and {
    builtin.length_of_bytearray(bytes) == 9998,
    builtin.slice_bytearray(43, 1, bytes) == #"ff",
  }
}

test enc_02_context_four_payouts() {
  let intent = SettleIntent {
    ..context_2(),
    payouts: [
      script_payout(),
      script_payout(),
      script_payout(),
      script_payout(),
    ],
  }
  context(intent) == 448926563740685306690298479937385490566780548522141465583438058900724720720
}

test enc_02_inline_script_stake_bytes() {
  let payout = script_payout()
  let address = Address {
    ..payout.address,
    stake_credential: Some(
      Inline(
        Script(#"66666666666666666666666666666666666666666666666666666666"),
      ),
    ),
  }
  intent_bytes(
    SettleIntent { ..context_1(), payouts: [Payout { ..payout, address }] },
  ) == #"7a626173652f696e74656e742f7631111111111111111111111111111111111111111111111111111111110101555555555555555555555555555555555555555555555555555555550101666666666666666666666666666666666666666666666666666666660000000000bc614e01777777777777777777777777777777777777777777777777777777777777777700000001a0c4506c00"
}
