use aiken/collection/list
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction}

pub type State {
  counter: Int,
  payees: List<ByteArray>,
}

pub type Settle {
  counter: Int,
  proof: ByteArray,
  signer: ByteArray,
  nullifier_proof: ByteArray,
}

validator stub {
  spend(
    _datum: Option<State>,
    redeemer: Settle,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(own) = transaction.find_input(tx.inputs, own_ref)
    expect InlineDatum(old_data) = own.output.datum
    expect old: State = old_data
    expect [pool, p1, p2, p3, p4, ..] = tx.outputs
    expect InlineDatum(new_data) = pool.datum
    expect new: State = new_data
    expect [k1, k2, k3, k4] = old.payees
    expect Finite(_) = tx.validity_range.upper_bound.bound_type
    // Reading a reference datum makes a missing or wrong reference observable.
    let reads_reference = list.any(
      tx.reference_inputs,
      fn(input) {
        when input.output.datum is {
          InlineDatum(value) -> value == redeemer.counter
          _ -> False
        }
      },
    )
    and {
      bytearray.length(redeemer.proof) == 192,
      bytearray.length(redeemer.nullifier_proof) == 0 || bytearray.length(
        redeemer.nullifier_proof,
      ) == 760,
      redeemer.counter == old.counter,
      pool.address == own.output.address,
      new.counter == old.counter + 1,
      new.payees == old.payees,
      list.length(tx.reference_inputs) >= 2,
      reads_reference,
      list.has(tx.extra_signatories, redeemer.signer),
      p1.address == address.from_verification_key(k1),
      p2.address == address.from_verification_key(k2),
      p3.address == address.from_verification_key(k3),
      p4.address == address.from_verification_key(k4),
      assets.lovelace_of(p1.value) == 2_000_000,
      assets.lovelace_of(p2.value) == 3_000_000,
      assets.lovelace_of(p3.value) == 4_000_000,
      assets.lovelace_of(p4.value) == 5_000_000,
      assets.is_zero(tx.mint),
      tx.withdrawals == [],
      tx.certificates == [],
    }
  }

  else(_) {
    fail
  }
}
