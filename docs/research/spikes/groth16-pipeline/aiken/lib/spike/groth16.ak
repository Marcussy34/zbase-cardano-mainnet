//// Minimal Groth16 verifier over BLS12-381 for the spike, built only from
//// Plutus V3 builtins. Checks
////
////   e(A, B) == e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
////   with vk_x = IC[0] + sum(x_i * IC[i + 1])
////
//// Rules (numbered as in the spike brief):
////   V1  every public input x satisfies 0 <= x < r, else False.
////   V2  proof points have the exact length, are canonical
////       (compress(uncompress(p)) == p) and are not the point at infinity,
////       else False. Bytes that are not a valid point at all make the
////       uncompress builtin fail, which also rejects the transaction.
////   V3  number of public inputs == number of IC points - 1, else False.
////   V4  4 Miller loops, 2 Miller result multiplications, 1 final verify.
////   V5  a public input equal to 0 is skipped (no uncompress, no scalar mul).
////   V6  verify_msm computes vk_x with bls12_381_g1_multi_scalar_mul.
////
//// Verification key points are trusted (they are fixed in the script), so
//// they are uncompressed without the V2 checks.

use aiken/builtin

/// BLS12-381 scalar field order r.
pub const fr_order: Int =
  52435875175126190479447740508185965837690552500527637822603658699938581184513

/// Zcash encodings of the point at infinity (flags 0b110, all else zero).
const g1_infinity: ByteArray =
  #"c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

const g2_infinity: ByteArray =
  #"c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

/// Compressed verification key, as produced by scripts/compress.mjs.
pub type VerificationKey {
  alpha_g1: ByteArray,
  beta_g2: ByteArray,
  gamma_g2: ByteArray,
  delta_g2: ByteArray,
  ic: List<ByteArray>,
}

/// Compressed Groth16 proof (A and C in G1, B in G2).
pub type Proof {
  a: ByteArray,
  b: ByteArray,
  c: ByteArray,
}

/// Production entry point (loop path): V1 first, then everything else.
pub fn verify(vk: VerificationKey, proof: Proof, inputs: List<Int>) -> Bool {
  inputs_in_field(inputs) && verify_unchecked_range(vk, proof, inputs)
}

/// V6: same as `verify`, but vk_x comes from the multi-scalar builtin.
pub fn verify_msm(vk: VerificationKey, proof: Proof, inputs: List<Int>) -> Bool {
  // V1 runs first; && short-circuits, so an out-of-range input never
  // reaches the MSM builtin.
  inputs_in_field(inputs) && pairing_check(
    vk,
    proof,
    compute_vk_x_msm(vk, inputs),
  )
}

/// CONTROL ONLY, never use in a validator: `verify` without rule V1. It
/// exists so a test can measure what an aliased input (x + r) does when
/// the range check is missing.
pub fn verify_unchecked_range(
  vk: VerificationKey,
  proof: Proof,
  inputs: List<Int>,
) -> Bool {
  pairing_check(vk, proof, compute_vk_x(vk, inputs))
}

/// V1: every public input is a canonical scalar, 0 <= x < r. Without this
/// check x and x + r give the same vk_x, because scalar multiplication
/// works modulo r.
pub fn inputs_in_field(inputs: List<Int>) -> Bool {
  when inputs is {
    [] -> True
    [x, ..rest] -> x >= 0 && x < fr_order && inputs_in_field(rest)
  }
}

/// vk_x by repeated scalar multiplication and addition (loop path).
/// Returns None when V3 fails.
pub fn compute_vk_x(vk: VerificationKey, inputs: List<Int>) -> Option<G1Element> {
  when vk.ic is {
    [] -> None
    [ic0, ..ic_rest] ->
      do_vk_x(builtin.bls12_381_g1_uncompress(ic0), inputs, ic_rest)
  }
}

fn do_vk_x(
  acc: G1Element,
  inputs: List<Int>,
  ic: List<ByteArray>,
) -> Option<G1Element> {
  when inputs is {
    // V3: inputs and IC points must run out at the same time.
    [] ->
      when ic is {
        [] -> Some(acc)
        _ -> None
      }
    [x, ..xs] ->
      when ic is {
        [] -> None
        [p, ..ps] ->
          // V5: a zero input contributes nothing, so skip the uncompress
          // and the scalar multiplication.
          if x == 0 {
            do_vk_x(acc, xs, ps)
          } else {
            let point = builtin.bls12_381_g1_uncompress(p)
            let term = builtin.bls12_381_g1_scalar_mul(x, point)
            do_vk_x(builtin.bls12_381_g1_add(acc, term), xs, ps)
          }
      }
  }
}

/// V6: vk_x = MSM([1, x_1, ..], [IC[0], IC[1], ..]) with one builtin call.
/// Zero inputs are left out of both lists (V5). Returns None when V3 fails.
/// The V3 check matters here: the builtin does not reject lists of
/// different lengths, it silently ignores the extra elements of the longer
/// list (measured by the msm_ignores_extra_elements test).
pub fn compute_vk_x_msm(
  vk: VerificationKey,
  inputs: List<Int>,
) -> Option<G1Element> {
  when vk.ic is {
    [] -> None
    [ic0, ..ic_rest] ->
      do_msm_terms(inputs, ic_rest, [1], [builtin.bls12_381_g1_uncompress(ic0)])
  }
}

fn do_msm_terms(
  inputs: List<Int>,
  ic: List<ByteArray>,
  scalars: List<Int>,
  points: List<G1Element>,
) -> Option<G1Element> {
  when inputs is {
    [] ->
      when ic is {
        [] -> Some(builtin.bls12_381_g1_multi_scalar_mul(scalars, points))
        _ -> None
      }
    [x, ..xs] ->
      when ic is {
        [] -> None
        [p, ..ps] ->
          if x == 0 {
            do_msm_terms(xs, ps, scalars, points)
          } else {
            do_msm_terms(
              xs,
              ps,
              [x, ..scalars],
              [builtin.bls12_381_g1_uncompress(p), ..points],
            )
          }
      }
  }
}

/// V2 for a G1 proof point.
fn decode_g1(bytes: ByteArray) -> Option<G1Element> {
  if builtin.length_of_bytearray(bytes) == 48 && bytes != g1_infinity {
    let point = builtin.bls12_381_g1_uncompress(bytes)
    if builtin.bls12_381_g1_compress(point) == bytes {
      Some(point)
    } else {
      None
    }
  } else {
    None
  }
}

/// V2 for a G2 proof point.
fn decode_g2(bytes: ByteArray) -> Option<G2Element> {
  if builtin.length_of_bytearray(bytes) == 96 && bytes != g2_infinity {
    let point = builtin.bls12_381_g2_uncompress(bytes)
    if builtin.bls12_381_g2_compress(point) == bytes {
      Some(point)
    } else {
      None
    }
  } else {
    None
  }
}

/// V2 on the three proof points, then the V4 pairing check. Nested `when`
/// (instead of matching one tuple) stops at the first failure; measured as
/// about 1.5M CPU cheaper on a valid proof than the tuple form.
fn pairing_check(
  vk: VerificationKey,
  proof: Proof,
  vk_x: Option<G1Element>,
) -> Bool {
  when vk_x is {
    None -> False
    Some(vk_x) ->
      when decode_g1(proof.a) is {
        None -> False
        Some(a) ->
          when decode_g2(proof.b) is {
            None -> False
            Some(b) ->
              when decode_g1(proof.c) is {
                None -> False
                Some(c) -> pairing_holds(vk, vk_x, a, b, c)
              }
          }
      }
  }
}

/// V4: e(A, B) == e(alpha, beta) * e(vk_x, gamma) * e(C, delta), checked as
/// final_verify(ml(A, B), ml(alpha, beta) * ml(vk_x, gamma) * ml(C, delta))
/// with four Miller loops, two multiplications and one final verify.
fn pairing_holds(
  vk: VerificationKey,
  vk_x: G1Element,
  a: G1Element,
  b: G2Element,
  c: G1Element,
) -> Bool {
  let alpha = builtin.bls12_381_g1_uncompress(vk.alpha_g1)
  let beta = builtin.bls12_381_g2_uncompress(vk.beta_g2)
  let gamma = builtin.bls12_381_g2_uncompress(vk.gamma_g2)
  let delta = builtin.bls12_381_g2_uncompress(vk.delta_g2)
  let ml_ab = builtin.bls12_381_miller_loop(alpha, beta)
  let ml_xg = builtin.bls12_381_miller_loop(vk_x, gamma)
  let ml_cd = builtin.bls12_381_miller_loop(c, delta)
  let rhs = builtin.bls12_381_mul_miller_loop_result(
    builtin.bls12_381_mul_miller_loop_result(ml_ab, ml_xg),
    ml_cd,
  )
  builtin.bls12_381_final_verify(builtin.bls12_381_miller_loop(a, b), rhs)
}
