pragma circom 2.0.0;

// Spike circuit: one constraint, d = a * b + c.
// a and b are private; c is a public input; d is a public output.
// snarkjs orders public signals as outputs first, then public inputs,
// so the public signal vector is [d, c].
template Mul() {
    signal input a;
    signal input b;
    signal input c;
    signal output d;

    d <== a * b + c;
}

component main {public [c]} = Mul();
