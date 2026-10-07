//// Public fixtures from docs/vectors/groth16-vectors.json, section 9.
//// The development key is only for these tests.

use aiken/builtin
use zx402/groth16.{Proof, VerificationKey, fr_order, in_field, verify}

fn vk() -> VerificationKey {
  VerificationKey {
    alpha: #"91d2818338afc909d485a8d59597eba6fbdab091bd686ef52005e569d256e8fd3077c509e226bd16ea1764f67d0fd999",
    beta: #"86425dbce28f2bbe8b7fdf5d7b9eaa8f435155643d505a68803d11d92bde56e3df9d3ef3d27f49b23468d74ca60909fa190a478692ae34909355ddf92a83109f900b1384c617b7fe22e9a5debeb88805545bc0660a3a6ab078b0e2b7794f5b9d",
    gamma: #"93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8",
    delta: #"8ab01564d7dc3d4b20872f68a9cfb0f4c4113d400771554cebda3525daefde95ed8b19eef544a5e0b93fec0c20e7f0f8146ae94f8a70dc48b676208a4fba786fbe43cbeb1ffa20649dfd09b3c0b850a08123ffdc17ee7be89696835f03485601",
    ic: [
      #"a8bc06cac776073ae33eecef4e6719a88dada0cbbf00c22ebcbda61d4d8811e749792e053651f7d0ea5ef3b80234b07d",
      #"97f780c0ddc2cb146123b6d1a5e9c5bd21dd385610feb41dd0079cfbaa261f37e6fad1786938b42e8accc0ce3e01b91c",
      #"99f1e0e23f9693023bb97bc1bb7461f0739cc5dd02d0bf48ea62fcec61957f82e47f85b46f05752f1958ee47e6554d01",
    ],
  }
}

fn proof_1() -> Proof {
  Proof {
    a: #"840679528d4326d7cc856bf3d6fc7ebadd18a5aa6b1a233e93a06dc7a8edefc059e8d775872d5f29f5159aea169fc4c8",
    b: #"97c5a1af533150935877339f5d0376ad86bfb37f3e3f6ddc9d74b440eeff7f0ffb04e56a3b04d8ae5b2d24247828dcdc0fad6f141c7d684778caca6f0af760da0193024af930d31708d799bff19ed8129b32fe58f1eb254a0dd6d3c2e67bc86f",
    c: #"b0ca2896c7e9adaafb40259a20d4a8fba7859693491e421d89831f63535cd00316984737c61d4b43cf061cef5a9410b2",
  }
}

fn proof_2() -> Proof {
  Proof {
    a: #"90f19e65a20af7555aa37299913cd9d060b53014a112c208b7374d1a3502d2473e4e2ad7a9c7597f9d7a6fadb1f61145",
    b: #"a3fd291b3e6f9d7b722e1ad37019e804cbbd822c7741976959f8e19fa0fbe90f598cb7bc65378ac89ede18a89c9785e6078b203f075ddfeb8123133de9a8294d92f929d505ef10be7caf482d91cac0859cefbca4c07b61c498507d2cf52cb64b",
    c: #"8dda982b272c2275d3ec3dd0692dc9a3162bdeabce09369f24820b980f87d8dd32c4634b61dd0ad5c9532c740528d133",
  }
}

test ver_00_proof_1_verifies() {
  verify(vk(), proof_1(), [17, 5])
}

test ver_00_proof_2_verifies() {
  verify(vk(), proof_2(), [42, 0])
}

test ver_01_first_input_alias_is_rejected() {
  !verify(vk(), proof_1(), [17 + fr_order, 5])
}

test ver_01_second_input_alias_is_rejected() {
  !verify(vk(), proof_1(), [17, 5 + fr_order])
}

test ver_01_negative_input_is_rejected() {
  !verify(vk(), proof_1(), [-1, 5])
}

test ver_01_in_field_edges() {
  and {
    !in_field(-1),
    in_field(0),
    in_field(fr_order - 1),
    !in_field(fr_order),
  }
}

test ver_02_short_a_is_rejected() {
  let p = proof_1()
  !verify(vk(), Proof { ..p, a: builtin.slice_bytearray(0, 47, p.a) }, [17, 5])
}

test ver_02_infinity_a_is_rejected() {
  let p = proof_1()
  let infinity = #"c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  !verify(vk(), Proof { ..p, a: infinity }, [17, 5])
}

test ver_02_short_b_is_rejected() {
  let p = proof_1()
  !verify(vk(), Proof { ..p, b: builtin.slice_bytearray(0, 95, p.b) }, [17, 5])
}

test ver_02_infinity_b_is_rejected() {
  let p = proof_1()
  let infinity = #"c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  !verify(vk(), Proof { ..p, b: infinity }, [17, 5])
}

test ver_02_short_c_is_rejected() {
  let p = proof_1()
  !verify(vk(), Proof { ..p, c: builtin.slice_bytearray(0, 47, p.c) }, [17, 5])
}

test ver_02_infinity_c_is_rejected() {
  let p = proof_1()
  let infinity = #"c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  !verify(vk(), Proof { ..p, c: infinity }, [17, 5])
}

// This encoding is on the curve but outside the prime-order subgroup.
test ver_02_invalid_point_fails_script() fail {
  let p = proof_1()
  let invalid = #"800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  verify(vk(), Proof { ..p, a: invalid }, [17, 5])
}

test ver_03_too_few_inputs_are_rejected() {
  !verify(vk(), proof_1(), [17])
}

test ver_03_too_many_inputs_are_rejected() {
  !verify(vk(), proof_1(), [17, 5, 1])
}

test ver_04_tampered_proof_is_rejected() {
  let p = proof_1()
  !verify(vk(), Proof { ..p, c: p.a }, [17, 5])
}

test ver_04_wrong_input_is_rejected() {
  !verify(vk(), proof_1(), [18, 5])
}

// check-budgets.mjs enforces the saving from skipping the zero input.
test ver_05_zero_input_is_skipped() {
  verify(vk(), proof_2(), [42, 0])
}

// check-budgets.mjs detects costly point wrapping in this verification.
test ver_06_two_inputs_within_budget() {
  verify(vk(), proof_1(), [17, 5])
}
