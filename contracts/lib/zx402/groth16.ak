//// Groth16 verifier over BLS12-381 using Plutus V3 builtins.
//// This approach adapts the Apache-2.0 verifiers from the Cardano
//// Foundation (cardano-foundation/bls) and DAYZERO.

use aiken/builtin
use aiken/collection/list

/// BLS12-381 scalar field order r.
pub const fr_order: Int =
  52435875175126190479447740508185965837690552500527637822603658699938581184513

pub type Proof {
  /// Compressed G1, 48 bytes.
  a: ByteArray,
  /// Compressed G2, 96 bytes.
  b: ByteArray,
  /// Compressed G1, 48 bytes.
  c: ByteArray,
}

/// Trusted script parameters, stored as compressed points.
pub type VerificationKey {
  alpha: ByteArray,
  beta: ByteArray,
  gamma: ByteArray,
  delta: ByteArray,
  ic: List<ByteArray>,
}

const g1_infinity: ByteArray =
  #"c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

const g2_infinity: ByteArray =
  #"c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

/// Rule V1: 0 <= x < r.
pub fn in_field(x: Int) -> Bool {
  x >= 0 && x < fr_order
}

/// True only for a valid proof with canonical public inputs and points.
pub fn verify(vk: VerificationKey, proof: Proof, public: List<Int>) -> Bool {
  // Reject cheap input errors before any curve builtin can fail or reduce x.
  if and {
    list.all(public, in_field),
    list.length(vk.ic) == list.length(public) + 1,
    builtin.length_of_bytearray(proof.a) == 48,
    builtin.length_of_bytearray(proof.b) == 96,
    builtin.length_of_bytearray(proof.c) == 48,
    proof.a != g1_infinity,
    proof.b != g2_infinity,
    proof.c != g1_infinity,
  } {
    // Invalid encodings fail in uncompress. Keep decoded points unwrapped.
    let a = builtin.bls12_381_g1_uncompress(proof.a)
    let b = builtin.bls12_381_g2_uncompress(proof.b)
    let c = builtin.bls12_381_g1_uncompress(proof.c)
    and {
      builtin.bls12_381_g1_compress(a) == proof.a,
      builtin.bls12_381_g2_compress(b) == proof.b,
      builtin.bls12_381_g1_compress(c) == proof.c,
      // The length check guarantees ic[0] and one point per public input.
      {
        expect [ic0, ..ic] = vk.ic
        let vk_x = accumulate(builtin.bls12_381_g1_uncompress(ic0), public, ic)
        pairing_holds(vk, vk_x, a, b, c)
      },
    }
  } else {
    False
  }
}

fn accumulate(
  acc: G1Element,
  public: List<Int>,
  ic: List<ByteArray>,
) -> G1Element {
  when public is {
    [] -> acc
    [x, ..xs] -> {
      expect [p, ..ps] = ic
      // A zero term needs neither decompression nor scalar multiplication.
      if x == 0 {
        accumulate(acc, xs, ps)
      } else {
        let point = builtin.bls12_381_g1_uncompress(p)
        let term = builtin.bls12_381_g1_scalar_mul(x, point)
        accumulate(builtin.bls12_381_g1_add(acc, term), xs, ps)
      }
    }
  }
}

fn pairing_holds(
  vk: VerificationKey,
  vk_x: G1Element,
  a: G1Element,
  b: G2Element,
  c: G1Element,
) -> Bool {
  // Key points are trusted parameters, so V2 applies only to proof points.
  let alpha = builtin.bls12_381_g1_uncompress(vk.alpha)
  let beta = builtin.bls12_381_g2_uncompress(vk.beta)
  let gamma = builtin.bls12_381_g2_uncompress(vk.gamma)
  let delta = builtin.bls12_381_g2_uncompress(vk.delta)
  let ml_ab = builtin.bls12_381_miller_loop(alpha, beta)
  let ml_xg = builtin.bls12_381_miller_loop(vk_x, gamma)
  let ml_cd = builtin.bls12_381_miller_loop(c, delta)
  let rhs = builtin.bls12_381_mul_miller_loop_result(
    builtin.bls12_381_mul_miller_loop_result(ml_ab, ml_xg),
    ml_cd,
  )
  builtin.bls12_381_final_verify(builtin.bls12_381_miller_loop(a, b), rhs)
}
