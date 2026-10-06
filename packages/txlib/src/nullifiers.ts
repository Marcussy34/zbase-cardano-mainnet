import { Trie } from '@aiken-lang/merkle-patricia-forestry';
import { nullifierKey } from '@zbase-cardano/crypto';

const root = (trie: Trie): string => (trie.hash ?? Buffer.alloc(32)).toString('hex');

async function spentTrie(spent: readonly bigint[]): Promise<Trie> {
  const trie = new Trie();
  for (const hash of new Set(spent)) await trie.insert(Buffer.from(nullifierKey(hash)), Buffer.from([1]));
  return trie;
}

/** Proves addition to the spent set, rejecting a nullifier that is already present. */
export async function nullifierInsertion(spent: readonly bigint[], next: bigint): Promise<{ proofCbor: string; oldRoot: string; newRoot: string }> {
  const key = Buffer.from(nullifierKey(next));
  if (spent.includes(next)) throw new Error('Nullifier is already spent');
  const trie = await spentTrie(spent);
  const oldRoot = root(trie);
  await trie.insert(key, Buffer.from([1]));
  // A membership proof after insertion proves absence against the preceding root.
  const proof = await trie.prove(key);
  return { proofCbor: proof.toCBOR().toString('hex'), oldRoot, newRoot: root(trie) };
}

/** Returns the on-chain root, where an empty trie is 32 zero bytes. */
export async function nullifierRoot(spent: readonly bigint[]): Promise<string> {
  return root(await spentTrie(spent));
}
