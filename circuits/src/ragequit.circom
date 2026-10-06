pragma circom 2.2.0;

include "lib/note.circom";
include "lib/merkle.circom";

template Ragequit(depth) {
    signal output nullifierHash;
    signal input stateRoot;
    signal input value;
    signal input label;
    signal input nullifier;
    signal input secret;
    signal input siblings[depth];
    signal input index;

    component precommitment = Precommitment();
    precommitment.nullifier <== nullifier;
    precommitment.secret <== secret;

    component commitment = Commitment();
    commitment.value <== value;
    commitment.label <== label;
    commitment.precommitment <== precommitment.out;

    component membership = MerkleRoot(depth);
    membership.leaf <== commitment.out;
    membership.index <== index;
    for (var i = 0; i < depth; i++) {
        membership.siblings[i] <== siblings[i];
    }
    // Bind the payout value and label to the note in the public state root.
    membership.root === stateRoot;

    component spent = NullifierHash();
    spent.nullifier <== nullifier;
    nullifierHash <== spent.out;
}
