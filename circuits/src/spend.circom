pragma circom 2.2.0;

include "lib/note.circom";
include "lib/merkle.circom";

template Spend(depth) {
    signal output newCommitment;
    signal output nullifierHash;

    signal input withdrawnValue;
    signal input stateRoot;
    signal input aspRoot;
    signal input context;

    signal input label;
    signal input existingValue;
    signal input existingNullifier;
    signal input existingSecret;
    signal input newNullifier;
    signal input newSecret;
    signal input stateSiblings[depth];
    signal input stateIndex;
    signal input aspSiblings[depth];
    signal input aspIndex;

    signal remaining;
    remaining <== existingValue - withdrawnValue;

    // All three bounds prevent both overspending and subtraction wrapped in the field.
    component existingValueBits = Num2Bits(64);
    existingValueBits.in <== existingValue;
    component withdrawnValueBits = Num2Bits(64);
    withdrawnValueBits.in <== withdrawnValue;
    component remainingBits = Num2Bits(64);
    remainingBits.in <== remaining;

    component existingPrecommitment = Precommitment();
    existingPrecommitment.nullifier <== existingNullifier;
    existingPrecommitment.secret <== existingSecret;
    component existingCommitment = Commitment();
    existingCommitment.value <== existingValue;
    existingCommitment.label <== label;
    existingCommitment.precommitment <== existingPrecommitment.out;

    component statePath = MerkleRoot(depth);
    statePath.leaf <== existingCommitment.out;
    statePath.index <== stateIndex;
    component aspPath = MerkleRoot(depth);
    aspPath.leaf <== label;
    aspPath.index <== aspIndex;
    for (var i = 0; i < depth; i++) {
        statePath.siblings[i] <== stateSiblings[i];
        aspPath.siblings[i] <== aspSiblings[i];
    }
    statePath.root === stateRoot;
    aspPath.root === aspRoot;

    // An empty ASP leaf must never approve a note with label zero.
    component zeroLabel = IsZero();
    zeroLabel.in <== label;
    zeroLabel.out === 0;

    component spentNullifier = NullifierHash();
    spentNullifier.nullifier <== existingNullifier;
    nullifierHash <== spentNullifier.out;

    component changePrecommitment = Precommitment();
    changePrecommitment.nullifier <== newNullifier;
    changePrecommitment.secret <== newSecret;
    component changeCommitment = Commitment();
    changeCommitment.value <== remaining;
    changeCommitment.label <== label;
    changeCommitment.precommitment <== changePrecommitment.out;
    newCommitment <== changeCommitment.out;

    component sameNullifier = IsEqual();
    sameNullifier.in[0] <== newNullifier;
    sameNullifier.in[1] <== existingNullifier;
    sameNullifier.out === 0;

    // A nonlinear constraint keeps the intent context bound after O2 optimization.
    signal contextSquare;
    contextSquare <== context * context;
}
