pragma circom 2.2.0;

include "../spend.circom";

component main {public [withdrawnValue, stateRoot, aspRoot, context]} = Spend(32);
