//// Test fixtures only. These helpers do not enforce validator rules.

use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets.{Assets, PolicyId}
use cardano/transaction as tx
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, ValidityRange,
}

/// A fixed first signing key hash, with no associated private key.
pub const key_hash_1: VerificationKeyHash =
  #"11111111111111111111111111111111111111111111111111111111"

/// A fixed second signing key hash, with no associated private key.
pub const key_hash_2: VerificationKeyHash =
  #"22222222222222222222222222222222222222222222222222222222"

/// A fixed third signing key hash, with no associated private key.
pub const key_hash_3: VerificationKeyHash =
  #"33333333333333333333333333333333333333333333333333333333"

/// A fixed signing key hash for an unrelated signer.
pub const key_hash_4: VerificationKeyHash =
  #"44444444444444444444444444444444444444444444444444444444"

/// A fixed first script hash for constructing script addresses.
pub const script_hash_1: ScriptHash =
  #"55555555555555555555555555555555555555555555555555555555"

/// A fixed second script hash for constructing script addresses.
pub const script_hash_2: ScriptHash =
  #"66666666666666666666666666666666666666666666666666666666"

/// A fixed policy ID for the three pool NFTs in tests.
pub const nft_policy: PolicyId =
  #"77777777777777777777777777777777777777777777777777777777"

/// A fixed first output reference, also used as the NFT seed.
pub const output_reference_1: OutputReference =
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: 0,
  }

/// A fixed second output reference in the same sample transaction.
pub const output_reference_2: OutputReference =
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: 1,
  }

/// A fixed third output reference in the same sample transaction.
pub const output_reference_3: OutputReference =
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: 2,
  }

/// Build a transaction with empty governance fields and zero fees.
pub fn transaction(
  inputs: List<Input>,
  reference_inputs: List<Input>,
  outputs: List<Output>,
  mint: Assets,
  extra_signatories: List<VerificationKeyHash>,
  validity_range: ValidityRange,
) -> Transaction {
  Transaction {
    ..tx.placeholder,
    inputs,
    reference_inputs,
    outputs,
    mint,
    extra_signatories,
    validity_range,
  }
}

/// Attach an output reference to a resolved output.
pub fn input(output_reference: OutputReference, output: Output) -> Input {
  Input { output_reference, output }
}

/// Build an output with an inline datum and no reference script.
pub fn output(address: Address, value: Assets, datum: Data) -> Output {
  Output { address, value, datum: InlineDatum(datum), reference_script: None }
}
