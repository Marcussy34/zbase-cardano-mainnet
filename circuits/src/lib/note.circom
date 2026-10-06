pragma circom 2.2.0;

include "poseidon-bls12381-circom/circuits/poseidon255.circom";

template Precommitment() {
    signal input nullifier;
    signal input secret;
    signal output out;

    component hash = Poseidon255(2);
    hash.in[0] <== nullifier;
    hash.in[1] <== secret;
    out <== hash.out;
}

template Commitment() {
    signal input value;
    signal input label;
    signal input precommitment;
    signal output out;

    component hash = Poseidon255(3);
    hash.in[0] <== value;
    hash.in[1] <== label;
    hash.in[2] <== precommitment;
    out <== hash.out;
}

template NullifierHash() {
    signal input nullifier;
    signal output out;

    component hash = Poseidon255(1);
    hash.in[0] <== nullifier;
    out <== hash.out;
}
