pragma circom 2.2.0;

include "gadgets.circom";
include "poseidon-bls12381-circom/circuits/poseidon255.circom";

// Separate the path from decomposition so an append uses one shared set of index bits.
template MerkleRootFromBits(depth) {
    signal input leaf;
    signal input indexBits[depth];
    signal input siblings[depth];
    signal output root;
    signal nodes[depth + 1];
    component order[depth];
    component hash[depth];

    nodes[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        order[i] = Mux2();
        order[i].selector <== indexBits[i];
        order[i].in[0] <== nodes[i];
        order[i].in[1] <== siblings[i];
        hash[i] = Poseidon255(2);
        hash[i].in[0] <== order[i].out[0];
        hash[i].in[1] <== order[i].out[1];
        nodes[i + 1] <== hash[i].out;
    }
    root <== nodes[depth];
}

template MerkleRoot(depth) {
    signal input leaf;
    signal input index;
    signal input siblings[depth];
    signal output root;

    component bits = Num2Bits(depth);
    bits.in <== index;
    component path = MerkleRootFromBits(depth);
    path.leaf <== leaf;
    for (var i = 0; i < depth; i++) {
        path.indexBits[i] <== bits.out[i];
        path.siblings[i] <== siblings[i];
    }
    root <== path.root;
}

template MerkleAppend(depth) {
    signal input enabled;
    signal input oldRoot;
    signal input index;
    signal input leaf;
    signal input siblings[depth];
    signal output newRoot;

    enabled * (enabled - 1) === 0;
    component bits = Num2Bits(depth);
    // Unused slots may carry any index, including the capacity after a final append.
    bits.in <== enabled * index;
    component emptyPath = MerkleRootFromBits(depth);
    component filledPath = MerkleRootFromBits(depth);
    emptyPath.leaf <== 0;
    filledPath.leaf <== leaf;
    for (var i = 0; i < depth; i++) {
        emptyPath.indexBits[i] <== bits.out[i];
        filledPath.indexBits[i] <== bits.out[i];
        emptyPath.siblings[i] <== siblings[i];
        filledPath.siblings[i] <== siblings[i];
    }
    enabled * (emptyPath.root - oldRoot) === 0;
    newRoot <== oldRoot + enabled * (filledPath.root - oldRoot);
}
