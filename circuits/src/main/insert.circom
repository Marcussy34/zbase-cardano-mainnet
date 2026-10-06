pragma circom 2.2.0;

include "../insert.circom";

component main {public [oldRoot, newRoot, startIndex, slots]} = Insert(32, 4);
