// Part 2 of the spike: convert snarkjs Groth16 JSON (verification key and
// proofs) to the Zcash compressed point format accepted by the Plutus
// builtins bls12_381_G1_uncompress (48 bytes) and bls12_381_G2_uncompress
// (96 bytes), then write out/vectors.json.
//
// Usage: node scripts/compress.mjs
// Exits non-zero if any self-check fails.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bls12_381 } from "@noble/curves/bls12-381.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const OUT = join(ROOT, "out");

const { G1, G2, fields } = bls12_381;
const { Fp, Fp2, Fr } = fields;
const P = Fp.ORDER; // base field modulus p (381 bits)
const R = Fr.ORDER; // scalar field order r

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const be48 = (n) => Buffer.from(n.toString(16).padStart(96, "0"), "hex");

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`SELF-CHECK FAILED: ${msg}`);
  }
}

// snarkjs writes projective coordinates as decimal strings in normal form
// (not Montgomery form), with z = 1 for finite points and z = 0 for
// infinity. Each G2 coordinate is an Fp2 element written as [c0, c1].
function g1FromSnarkjs([x, y, z]) {
  if (BigInt(z) === 0n) return G1.Point.ZERO;
  check(BigInt(z) === 1n, `G1 z must be 0 or 1, got ${z}`);
  const p = G1.Point.fromAffine({ x: BigInt(x), y: BigInt(y) });
  p.assertValidity(); // on curve and in the prime order subgroup
  return p;
}
function g2FromSnarkjs([x, y, z]) {
  if (BigInt(z[0]) === 0n && BigInt(z[1]) === 0n) return G2.Point.ZERO;
  check(BigInt(z[0]) === 1n && BigInt(z[1]) === 0n, `G2 z must be [1,0], got ${z}`);
  const fp2 = ([c0, c1]) => Fp2.fromBigTuple([BigInt(c0), BigInt(c1)]);
  const p = G2.Point.fromAffine({ x: fp2(x), y: fp2(y) });
  p.assertValidity();
  return p;
}

// Independent reference encoder written straight from the Zcash spec, used
// only to cross-check noble's encoder:
//   byte0 bit 7 (0x80) = compressed, bit 6 (0x40) = infinity,
//   bit 5 (0x20) = sign: set when y is the lexicographically larger root.
//   G1 payload = x (48 bytes BE). G2 payload = x.c1 || x.c0 (c1 FIRST).
function refCompressG1(pt) {
  if (pt.is0()) return Buffer.concat([Buffer.from([0xc0]), Buffer.alloc(47)]);
  const { x, y } = pt.toAffine();
  const out = be48(x);
  out[0] |= 0x80 | (y > (P - 1n) / 2n ? 0x20 : 0);
  return out;
}
function refCompressG2(pt) {
  if (pt.is0()) return Buffer.concat([Buffer.from([0xc0]), Buffer.alloc(95)]);
  const { x, y } = pt.toAffine();
  const out = Buffer.concat([be48(x.c1), be48(x.c0)]);
  // Fp2 lexicographic order compares c1 first, falling back to c0 when c1 = 0.
  const larger = y.c1 !== 0n ? y.c1 > (P - 1n) / 2n : y.c0 > (P - 1n) / 2n;
  out[0] |= 0x80 | (larger ? 0x20 : 0);
  return out;
}

// Compress with noble, then self-check: length, equality with the reference
// encoder, and decompress-and-compare with the original affine coordinates.
function compressG1(json, label) {
  const pt = g1FromSnarkjs(json);
  const bytes = pt.toBytes(true);
  check(bytes.length === 48, `${label}: G1 length ${bytes.length}`);
  check(hex(bytes) === hex(refCompressG1(pt)), `${label}: noble vs reference encoder`);
  const back = G1.Point.fromBytes(bytes);
  if (pt.is0()) check(back.is0(), `${label}: infinity roundtrip`);
  else {
    const a = back.toAffine();
    check(a.x === BigInt(json[0]) && a.y === BigInt(json[1]), `${label}: G1 roundtrip coords`);
  }
  return hex(bytes);
}
function compressG2(json, label) {
  const pt = g2FromSnarkjs(json);
  const bytes = pt.toBytes(true);
  check(bytes.length === 96, `${label}: G2 length ${bytes.length}`);
  check(hex(bytes) === hex(refCompressG2(pt)), `${label}: noble vs reference encoder`);
  const back = G2.Point.fromBytes(bytes);
  if (pt.is0()) check(back.is0(), `${label}: infinity roundtrip`);
  else {
    const { x, y } = back.toAffine();
    const [[x0, x1], [y0, y1]] = json;
    check(
      x.c0 === BigInt(x0) && x.c1 === BigInt(x1) && y.c0 === BigInt(y0) && y.c1 === BigInt(y1),
      `${label}: G2 roundtrip coords`,
    );
    checkWrongOrderRejected(bytes, label);
  }
  return hex(bytes);
}

// Pitfall demonstration: serializing x as c0 || c1 (the snarkjs JSON order)
// instead of c1 || c0 must not decode to the same point. In practice the
// swapped bytes are off the curve or outside the subgroup, so a decoder
// rejects them.
function checkWrongOrderRejected(bytes, label) {
  const flags = bytes[0] & 0xe0;
  const c1 = Buffer.from(bytes.subarray(0, 48));
  c1[0] &= 0x1f;
  const wrong = Buffer.concat([Buffer.from(bytes.subarray(48)), c1]);
  wrong[0] |= flags;
  let outcome;
  try {
    outcome = hex(G2.Point.fromBytes(wrong).toBytes(true)) === hex(bytes) ? "same point" : "different point";
  } catch (e) {
    outcome = `rejected (${e.message})`;
  }
  console.log(`  ${label}: swapped c0/c1 order -> ${outcome}`);
  check(outcome !== "same point", `${label}: swapped order decoded to the same point`);
}

// Known answer test: the generators must encode to the Zcash test vectors
// (the same constants appear in Plutus conformance tests).
check(
  hex(G1.Point.BASE.toBytes(true)) ===
    "97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb",
  "G1 generator encoding",
);
check(
  hex(G2.Point.BASE.toBytes(true)) ===
    "93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e" +
      "024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8",
  "G2 generator encoding",
);

// Off-chain pairing check with noble (independent of snarkjs):
// e(A, B) == e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
// with vk_x = IC[0] + sum(x_i * IC[i+1]).
function nobleVerify(vkJson, proofJson, publicSignals) {
  const ic = vkJson.IC.map(g1FromSnarkjs);
  let vkx = ic[0];
  publicSignals.forEach((s, i) => {
    const x = BigInt(s);
    if (x !== 0n) vkx = vkx.add(ic[i + 1].multiply(x)); // noble rejects scalar 0
  });
  const { pairing } = bls12_381;
  const Fp12 = fields.Fp12;
  const lhs = pairing(g1FromSnarkjs(proofJson.pi_a), g2FromSnarkjs(proofJson.pi_b));
  const rhs = Fp12.mul(
    Fp12.mul(
      pairing(g1FromSnarkjs(vkJson.vk_alpha_1), g2FromSnarkjs(vkJson.vk_beta_2)),
      pairing(vkx, g2FromSnarkjs(vkJson.vk_gamma_2)),
    ),
    pairing(g1FromSnarkjs(proofJson.pi_c), g2FromSnarkjs(vkJson.vk_delta_2)),
  );
  return Fp12.eql(lhs, rhs);
}

const vkJson = readJson(join(BUILD, "verification_key.json"));
check(vkJson.curve === "bls12381" && vkJson.protocol === "groth16", "vk curve/protocol");
check(vkJson.IC.length === vkJson.nPublic + 1, "IC length = nPublic + 1");

const vk = {
  alpha_g1: compressG1(vkJson.vk_alpha_1, "vk.alpha"),
  beta_g2: compressG2(vkJson.vk_beta_2, "vk.beta"),
  gamma_g2: compressG2(vkJson.vk_gamma_2, "vk.gamma"),
  delta_g2: compressG2(vkJson.vk_delta_2, "vk.delta"),
  ic: vkJson.IC.map((p, i) => compressG1(p, `vk.ic[${i}]`)),
};

const proofs = ["proof1", "proof2"].map((name) => {
  const dir = join(BUILD, name);
  const proofJson = readJson(join(dir, "proof.json"));
  const publicSignals = readJson(join(dir, "public.json"));
  publicSignals.forEach((s) => check(BigInt(s) >= 0n && BigInt(s) < R, `${name}: signal ${s} in Fr`));
  check(nobleVerify(vkJson, proofJson, publicSignals), `${name}: noble pairing check`);
  return {
    name,
    inputs: readJson(join(dir, "input.json")),
    a: compressG1(proofJson.pi_a, `${name}.a`),
    b: compressG2(proofJson.pi_b, `${name}.b`),
    c: compressG1(proofJson.pi_c, `${name}.c`),
    public_signals: publicSignals,
    snarkjs_proof: proofJson,
  };
});

const vectors = {
  description:
    "Groth16 over BLS12-381 for circuit/mul.circom (d = a*b + c, public signals [d, c]). " +
    "Points are Zcash compressed (G1 48 bytes, G2 96 bytes with x.c1 || x.c0).",
  scalar_field_order_r: R.toString(),
  vk,
  proofs,
  snarkjs_verification_key: vkJson,
};

if (failures > 0) {
  console.error(`compress.mjs: ${failures} self-check(s) failed`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "vectors.json"), JSON.stringify(vectors, null, 2) + "\n");
console.log("compress.mjs: all self-checks passed, wrote out/vectors.json");
