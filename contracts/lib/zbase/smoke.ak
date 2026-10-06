use aiken/merkle_patricia_forestry as mpf

test wp0_arithmetic() {
  1 + 1 == 2
}

test wp0_empty_mpf_root() {
  let trie = mpf.empty
  mpf.is_empty(trie) && mpf.root(trie) == #"0000000000000000000000000000000000000000000000000000000000000000"
}
