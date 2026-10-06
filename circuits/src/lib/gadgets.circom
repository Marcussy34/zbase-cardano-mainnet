pragma circom 2.2.0;

template Num2Bits(n) {
    // The sum must stay below the field modulus to prevent alternate bit encodings.
    assert(n > 0 && n <= 64);
    signal input in;
    signal output out[n];
    var sum = 0;
    var weight = 1;

    for (var i = 0; i < n; i++) {
        // Boolean constraints and the final weighted sum uniquely pin every hinted bit.
        out[i] <-- (in >> i) & 1;
        out[i] * (out[i] - 1) === 0;
        sum += out[i] * weight;
        weight *= 2;
    }
    sum === in;
}

template IsZero() {
    signal input in;
    signal output out;
    signal inverse;

    // The first two constraints pin the nonzero inverse; the last pins it to zero at zero input.
    inverse <-- in != 0 ? 1 / in : 0;
    out <== 1 - in * inverse;
    in * out === 0;
    out * inverse === 0;
}

template IsEqual() {
    signal input in[2];
    signal output out;

    component zero = IsZero();
    zero.in <== in[0] - in[1];
    out <== zero.out;
}

template Mux2() {
    signal input selector;
    signal input in[2];
    signal output out[2];

    selector * (selector - 1) === 0;
    out[0] <== in[0] + selector * (in[1] - in[0]);
    out[1] <== in[1] + selector * (in[0] - in[1]);
}
