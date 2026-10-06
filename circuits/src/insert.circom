pragma circom 2.2.0;

include "lib/merkle.circom";
include "lib/note.circom";

template Insert(depth, batch) {
    assert(depth > 0 && depth <= 64);
    assert(batch > 0);
    signal input oldRoot;
    signal input newRoot;
    signal input startIndex;
    signal input slots[batch][3];
    signal input siblings[batch][depth];

    signal used[batch];
    signal deposit[batch];
    signal leaf[batch];
    signal roots[batch + 1];
    signal indexes[batch + 1];
    component empty[batch];
    component note[batch];
    component valueBits[batch];
    component hash[batch];
    component append[batch];

    component startBits = Num2Bits(depth);
    startBits.in <== startIndex;
    roots[0] <== oldRoot;
    indexes[0] <== startIndex;
    for (var i = 0; i < batch; i++) {
        empty[i] = IsZero();
        empty[i].in <== slots[i][2];
        used[i] <== 1 - empty[i].out;
        note[i] = IsZero();
        note[i].in <== slots[i][1];
        deposit[i] <== 1 - note[i].out;

        // A nonempty prefix binds every used slot to the next free index.
        if (i == 0) {
            used[i] === 1;
        } else {
            used[i] * (1 - used[i - 1]) === 0;
        }
        empty[i].out * slots[i][0] === 0;
        empty[i].out * slots[i][1] === 0;
        note[i].out * slots[i][0] === 0;
        valueBits[i] = Num2Bits(64);
        valueBits[i].in <== slots[i][0];

        hash[i] = Commitment();
        hash[i].value <== slots[i][0];
        hash[i].label <== slots[i][1];
        hash[i].precommitment <== slots[i][2];
        leaf[i] <== slots[i][2] + deposit[i] * (hash[i].out - slots[i][2]);

        append[i] = MerkleAppend(depth);
        append[i].enabled <== used[i];
        append[i].oldRoot <== roots[i];
        // MerkleAppend gates index bits, so unused slots can follow a full tree.
        append[i].index <== indexes[i];
        append[i].leaf <== leaf[i];
        for (var j = 0; j < depth; j++) {
            append[i].siblings[j] <== siblings[i][j];
        }
        roots[i + 1] <== append[i].newRoot;
        indexes[i + 1] <== indexes[i] + used[i];
    }
    newRoot === roots[batch];
}
