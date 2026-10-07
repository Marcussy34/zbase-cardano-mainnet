use aiken/builtin
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Credential, Inline, Script, VerificationKey}
use cardano/transaction.{OutputReference}
use zx402/types.{Payout, SettleIntent}

/// SPEC 4.4. Fails when a length is wrong or the index does not fit in 4 bytes.
pub fn label(
  pool_id: ByteArray,
  deposit_ref: OutputReference,
  refund: VerificationKeyHash,
) -> Int {
  expect builtin.length_of_bytearray(pool_id) == 28
  expect builtin.length_of_bytearray(deposit_ref.transaction_id) == 32
  expect builtin.length_of_bytearray(refund) == 28
  "zx402/label/v1"
    |> builtin.append_bytearray(pool_id)
    |> builtin.append_bytearray(deposit_ref.transaction_id)
    |> builtin.append_bytearray(
        builtin.integer_to_bytearray(True, 4, deposit_ref.output_index),
      )
    |> builtin.append_bytearray(refund)
    |> hash_to_field
}

/// SPEC 4.5. The exact bytes that are hashed, also exposed for parity tests.
pub fn intent_bytes(intent: SettleIntent) -> ByteArray {
  expect builtin.length_of_bytearray(intent.pool_id) == 28
  // The pool enforces its payout limit. This layer enforces only the u8 width.
  let count = builtin.integer_to_bytearray(True, 1, list.length(intent.payouts))
  let suffix = optional_hash_bytes(
    intent.relayer,
    28,
    builtin.integer_to_bytearray(True, 8, intent.valid_until),
  )
  let payouts = list.foldr(intent.payouts, suffix, payout_bytes)
  "zx402/intent/v1"
    |> builtin.append_bytearray(intent.pool_id)
    |> builtin.append_bytearray(count)
    |> builtin.append_bytearray(payouts)
}

/// SPEC 4.5. Fails on any input the encoding does not allow.
pub fn context(intent: SettleIntent) -> Int {
  intent_bytes(intent) |> hash_to_field
}

/// SPEC 4.6. Fails for negative values or values that do not fit in 32 bytes.
pub fn nullifier_key(nullifier_hash: Int) -> ByteArray {
  builtin.integer_to_bytearray(True, 32, nullifier_hash)
}

fn hash_to_field(bytes: ByteArray) -> Int {
  // Truncation to 248 bits always yields a value below the scalar field order.
  bytes
    |> builtin.blake2b_256
    |> builtin.slice_bytearray(0, 31, _)
    |> builtin.bytearray_to_integer(True, _)
}

fn credential_bytes(credential: Credential, suffix: ByteArray) -> ByteArray {
  when credential is {
    VerificationKey(hash) -> {
      expect builtin.length_of_bytearray(hash) == 28
      builtin.cons_bytearray(0, builtin.append_bytearray(hash, suffix))
    }
    Script(hash) -> {
      expect builtin.length_of_bytearray(hash) == 28
      builtin.cons_bytearray(1, builtin.append_bytearray(hash, suffix))
    }
  }
}

fn optional_hash_bytes(
  hash: Option<ByteArray>,
  size: Int,
  suffix: ByteArray,
) -> ByteArray {
  when hash is {
    None -> builtin.cons_bytearray(0, suffix)
    Some(bytes) -> {
      expect builtin.length_of_bytearray(bytes) == size
      builtin.cons_bytearray(1, builtin.append_bytearray(bytes, suffix))
    }
  }
}

fn payout_bytes(payout: Payout, suffix: ByteArray) -> ByteArray {
  // Prepend fields onto the final suffix to avoid joining intermediate payouts.
  let datum = optional_hash_bytes(payout.datum_hash, 32, suffix)
  let amount = builtin.append_bytearray(
    builtin.integer_to_bytearray(True, 8, payout.amount),
    datum,
  )
  let stake = when payout.address.stake_credential is {
    None -> builtin.cons_bytearray(0, amount)
    Some(Inline(credential)) ->
      builtin.cons_bytearray(1, credential_bytes(credential, amount))
    Some(_) -> fail @"Pointer stake credentials have no intent encoding"
  }
  credential_bytes(payout.address.payment_credential, stake)
}
