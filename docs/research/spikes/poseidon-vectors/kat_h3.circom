pragma circom 2.0.0;

// Single Poseidon255(3) instance, compiled only to read its exact constraint count.
include "poseidon-bls12381-circom/circuits/poseidon255.circom";

component main = Poseidon255(3);
