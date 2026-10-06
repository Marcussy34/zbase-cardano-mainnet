pragma circom 2.0.0;

// Resolved through "-l node_modules" at compile time.
include "poseidon-bls12381-circom/circuits/poseidon255.circom";

// Known-answer circuit: one instance of each arity used by the protocol.
template Kat() {
    signal input a;
    signal input b;
    signal input c;
    signal output h1;
    signal output h2;
    signal output h3;

    component p1 = Poseidon255(1);
    p1.in[0] <== a;
    h1 <== p1.out;

    component p2 = Poseidon255(2);
    p2.in[0] <== a;
    p2.in[1] <== b;
    h2 <== p2.out;

    component p3 = Poseidon255(3);
    p3.in[0] <== a;
    p3.in[1] <== b;
    p3.in[2] <== c;
    h3 <== p3.out;
}

component main = Kat();
