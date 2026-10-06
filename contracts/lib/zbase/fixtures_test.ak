use aiken/collection/list
use aiken/merkle_patricia_forestry as mpf
use zbase/encoding
use zbase/fixtures/common
use zbase/fixtures/demo
use zbase/groth16
use zbase/pool/kit
use zbase/testkit

test ver_00_real_insert_verifies() {
  groth16.verify(common.vk_insert, demo.insert_proof, demo.insert_public_inputs)
}

test ver_04_real_insert_wrong_input() {
  expect [old_root, ..rest] = demo.insert_public_inputs
  !groth16.verify(common.vk_insert, demo.insert_proof, [old_root + 1, ..rest])
}

test ver_00_real_spend_verifies() {
  groth16.verify(common.vk_spend, demo.spend_proof, demo.spend_public_inputs)
}

test ver_04_real_spend_wrong_context() {
  !groth16.verify(
    common.vk_spend,
    demo.spend_proof,
    list.concat(list.take(demo.spend_public_inputs, 5), [demo.context + 1]),
  )
}

test ver_00_real_ragequit_verifies() {
  groth16.verify(common.vk_ragequit, demo.ragequit_proof, demo.ragequit_public_inputs)
}

test ver_04_real_ragequit_wrong_value() {
  !groth16.verify(
    common.vk_ragequit,
    demo.ragequit_proof,
    [demo.nullifier_hash, demo.state_root, demo.credited_value + 1, demo.label],
  )
}

test ver_04_real_proof_wrong_circuit_key() {
  !groth16.verify(common.vk_spend, demo.insert_proof, demo.spend_public_inputs)
}

test enc_01_demo_label_matches() {
  encoding.label(common.pool_id, demo.deposit_ref, demo.refund) == demo.label
}

test enc_02_demo_context_matches() {
  encoding.context(demo.intent) == demo.context
}

test enc_03_demo_nullifier_key_matches() {
  encoding.nullifier_key(demo.nullifier_hash) == demo.nullifier_key
}

test pool_s8_first_trie_insert_matches() {
  let root = mpf.empty
    |> mpf.insert(demo.nullifier_key, #"01", demo.trie_proof_1)
    |> mpf.root
  root == demo.nullifier_root_1
}

test pool_s8_second_trie_insert_matches() {
  let root = mpf.from_root(demo.nullifier_root_1)
    |> mpf.insert(demo.second_nullifier_key, #"01", demo.trie_proof_2)
    |> mpf.root
  root == demo.nullifier_root_2
}

test pool_s8_duplicate_trie_key_fails() fail {
  expect _ = mpf.from_root(demo.nullifier_root_1)
    |> mpf.insert(demo.nullifier_key, #"01", demo.trie_proof_1)
  True
}

test pool_s8_wrong_trie_key_fails() fail {
  expect _ = mpf.from_root(demo.nullifier_root_1)
    |> mpf.insert(demo.nullifier_key, #"01", demo.trie_proof_2)
  True
}

test pool_i0_sample_values_match_testkit() {
  and {
    common.pool_id == kit.nft_policy,
    common.nft_policy == kit.nft_policy,
    common.deposit_script == kit.deposit_script,
    common.pool_script == kit.pool_script,
    common.pool_address == kit.pool_address,
    common.config_address == kit.config_address,
    common.asp_address == kit.asp_address,
    common.treasury_address == kit.treasury_address,
    common.pool_ref == kit.pool_ref,
    common.key_hash_1 == testkit.key_hash_1,
    common.key_hash_2 == testkit.key_hash_2,
    common.key_hash_3 == testkit.key_hash_3,
    common.key_hash_4 == testkit.key_hash_4,
    common.script_hash_1 == testkit.script_hash_1,
    common.script_hash_2 == testkit.script_hash_2,
    common.output_reference_1 == testkit.output_reference_1,
    common.output_reference_2 == testkit.output_reference_2,
    common.output_reference_3 == testkit.output_reference_3,
    common.m0_config == kit.m0_config(),
    common.genesis_datum == kit.genesis_datum(),
    common.empty_state_root == list.expect_head(kit.genesis_datum().roots),
    common.empty_nullifier_root == mpf.root(mpf.empty),
  }
}

test pool_i0_demo_story_public_inputs_match() {
  expect [payout] = demo.intent.payouts
  and {
    demo.gross == 10_000_000,
    demo.deposit_fee == 0,
    demo.crank_fee == common.m0_config.crank_fee,
    demo.credited_value == demo.gross - demo.deposit_fee - demo.crank_fee,
    demo.credited_value == 9_700_000,
    demo.withdrawn == 3_000_000,
    demo.paid == 2_500_000,
    payout.amount == demo.paid,
    payout.address == common.payout_address,
    payout.datum_hash == None,
    demo.intent.pool_id == common.pool_id,
    demo.intent.relayer == None,
    demo.intent.valid_until == demo.valid_until,
    demo.insert_public_inputs == [
      common.empty_state_root, demo.state_root, 0,
      demo.credited_value, demo.label, demo.precommitment,
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    demo.spend_public_inputs == [
      demo.new_commitment, demo.nullifier_hash, demo.withdrawn,
      demo.state_root, demo.asp_root, demo.context,
    ],
    demo.ragequit_public_inputs == [
      demo.nullifier_hash, demo.state_root, demo.credited_value, demo.label,
    ],
  }
}
