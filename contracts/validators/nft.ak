use aiken/collection/dict
use aiken/collection/list
use aiken/interval
use cardano/address
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, OutputReference, Transaction}
use zbase/constants
use zbase/testkit

validator nft(seed: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    and {
      list.any(self.inputs, fn(input) { input.output_reference == seed }),
      dict.size(assets.tokens(self.mint, policy_id)) == 3,
      assets.quantity_of(self.mint, policy_id, constants.pool_nft_name) == 1,
      assets.quantity_of(self.mint, policy_id, constants.config_nft_name) == 1,
      assets.quantity_of(self.mint, policy_id, constants.asp_nft_name) == 1,
    }
  }

  else(_) {
    fail
  }
}

fn mint_transaction() -> Transaction {
  let seed = testkit.input(
    testkit.output_reference_1,
    testkit.output(
      address.from_verification_key(testkit.key_hash_1),
      assets.from_lovelace(10_000_000),
      Void,
    ),
  )
  let mint = assets.from_asset(testkit.nft_policy, constants.pool_nft_name, 1)
    |> assets.add(testkit.nft_policy, constants.config_nft_name, 1)
    |> assets.add(testkit.nft_policy, constants.asp_nft_name, 1)
  testkit.transaction([seed], [], [], mint, [], interval.everything)
}

test nft_00_seed_mints_three_nfts() {
  nft.mint(
    testkit.output_reference_1,
    Void,
    testkit.nft_policy,
    mint_transaction(),
  )
}

test nft_01_seed_not_spent() fail {
  let base = mint_transaction()
  let tx = Transaction { ..base, inputs: [] }
  expect nft.mint(testkit.output_reference_1, Void, testkit.nft_policy, tx)
  True
}

test nft_02_only_two_names() fail {
  let base = mint_transaction()
  let tx = Transaction {
    ..base,
    mint: assets.add(base.mint, testkit.nft_policy, constants.asp_nft_name, -1),
  }
  expect nft.mint(testkit.output_reference_1, Void, testkit.nft_policy, tx)
  True
}

test nft_02_fourth_name() fail {
  let base = mint_transaction()
  let tx = Transaction {
    ..base,
    mint: assets.add(base.mint, testkit.nft_policy, "extra", 1),
  }
  expect nft.mint(testkit.output_reference_1, Void, testkit.nft_policy, tx)
  True
}

test nft_02_quantity_two() fail {
  let base = mint_transaction()
  let tx = Transaction {
    ..base,
    mint: assets.add(base.mint, testkit.nft_policy, constants.pool_nft_name, 1),
  }
  expect nft.mint(testkit.output_reference_1, Void, testkit.nft_policy, tx)
  True
}

test nft_02_burn() fail {
  let base = mint_transaction()
  let tx = Transaction {
    ..base,
    mint: assets.add(base.mint, testkit.nft_policy, constants.pool_nft_name, -2),
  }
  expect nft.mint(testkit.output_reference_1, Void, testkit.nft_policy, tx)
  True
}

test nft_02_misspelled_name() fail {
  let base = mint_transaction()
  let mint = base.mint
    |> assets.add(testkit.nft_policy, constants.asp_nft_name, -1)
    |> assets.add(testkit.nft_policy, "ASP", 1)
  let tx = Transaction { ..base, mint }
  expect nft.mint(testkit.output_reference_1, Void, testkit.nft_policy, tx)
  True
}

test nft_01_different_seed_reference() fail {
  let base = mint_transaction()
  expect [seed] = base.inputs
  let tx = Transaction {
    ..base,
    inputs: [Input { ..seed, output_reference: testkit.output_reference_2 }],
  }
  expect nft.mint(testkit.output_reference_1, Void, testkit.nft_policy, tx)
  True
}
