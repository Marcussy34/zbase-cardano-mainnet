# zx402: comparison with the Base implementation

| Field | Value |
|---|---|
| Status | 2026-10-07 |
| Question | Does the Cardano port keep the safety rules of the Base implementation? |
| Compared | This repository at main, and the Privacy Pools rail on Base (the vendored 0xbow Privacy Pools contracts of that repository, and the facilitator and SDK code) |
| Who | The lead of the build, and two independent reviewers that read the code of both repositories. One read the circuits and the validators. One read the payment flow and the privacy |

## 1. Result

The protocol core is a sound port. Every public input of every proof is bound to chain data. Value is conserved in every action of the pool. No reader found a way to move value without a valid proof.

The port is not at the trust level of Base. Base runs the audited 0xbow contracts with keys from a public ceremony. The circuits and validators here are new code with keys that one party made, and nobody outside the project has reviewed them.

The readers found weaknesses outside the validators, in the SDK, in the relayer and in the trust in the operator. Five could cost money and are fixed. Section 4 lists all of them.

## 2. Rule by rule

`S` is the folder of the vendored Base contracts. `V` is `contracts/lib/zx402`. `C` is `circuits/src`.

| Rule | Base | Cardano | Result |
|---|---|---|---|
| A note is Poseidon(value, label, Poseidon(nullifier, secret)) | Hashed by the contract at deposit, `S/PrivacyPool.sol:98` | Hashed inside the insert proof, `C/lib/note.circom:5-36`, `C/insert.circom:50-54` | Same rule |
| A note is spent once | A map of spent nullifier hashes, `S/State.sol:123-129` | One trie root. The insert of the hash needs a proof that it is absent, `V/pool/common.ak:132-142` | Same rule, new mechanism |
| Only real deposits enter the tree | The contract hashes the tree, `S/State.sol:136-152` | An insert proof. The validator derives all 15 public inputs from the two datums, the queue and the spent deposit outputs, and forces the pool balance to grow by the credited sum, `V/pool/insert.ak:29-77` | Same rule, new mechanism |
| A spend proves ownership, approval and the amount | The 0xbow withdraw circuit | The same checks with a fixed depth of 32 and three 64-bit range checks, `C/spend.circom` | Same rule |
| A payment cannot be redirected | The context binds the recipient, the fee recipient and the fee rate, `S/PrivacyPool.sol:43-61`, `S/Entrypoint.sol:133-176` | The context binds the pool, every payout, the relayer key and an expiry. The validator checks the outputs in order, `V/pool/settle.ak:25-106`, `V/encoding.ak:28-47` | Same rule, plus an expiry |
| Only approved deposits pay in private | Only the latest association root, `S/PrivacyPool.sol:59` | Only the root in the association output that the transaction reads, `V/pool/common.ak:115-129` | Same rule |
| The depositor can always exit in public | A map from label to depositor, `S/PrivacyPool.sol:132-150` | The label is a hash that includes the refund key, and that key must sign. The proof holds the tree membership, `V/pool/ragequit.ak:23-42` | Same rule, new mechanism |
| Every public input is below the field modulus | In the generated verifier, `S/verifiers/WithdrawalVerifier.sol` | Before any curve operation, `V/groth16.ak:37-53` | Same rule |
| Who sees note secrets | The Base implementation's server makes the proof and gets the secrets | The agent makes the proof. The relayer gets the proof and the payouts | Stronger |
| Admin power | The owner can upgrade the entry contract, `S/Entrypoint.sol:308` | No upgrade. The admin can pause deposits and set bounded values, `contracts/validators/config.ak` | Stronger |
| A second deposit with the same precommitment | Refused on chain, `S/Entrypoint.sol:324-326` | Not refused on chain. The SDK prevents it | Weaker |
| The start state of the pool | Fixed by the constructor, `S/State.sol:79-94` | Written by the deployer and checked off chain in part | Weaker |
| The proving keys | From the 0xbow ceremony. The tree needs no keys at all | One party made them, and a forged insert proof can set any root | Weaker |
| Outside review | The core was audited | None | Missing |

## 3. The payment flow

Both products pay in two steps. The pool pays a key that is used once, and that key pays the seller with a payment that a stock x402 facilitator accepts.

The one-time key does not hide the pool. The chain shows that the pool funded it. It exists for two reasons. A stock seller cannot check or submit a pool transaction. And a new key for each payment keeps the payments of one agent apart.

| Who | What they learn on Base | What they learn here |
|---|---|---|
| Seller | A new payer key, the amount, the buyer's IP address, and that the pool funded the key | The same |
| Operator of the relayer | Everything: note secrets, label, deposit, change, recipient | IP address, time, the one-time address and the amount. No note, no label, no deposit |
| Operator of the indexer | The same operator: everything | IP address and the time of each sync. The SDK always downloads full lists |
| Anyone who reads the chain | Deposit, payment to the key, payment to the seller | The same shape. The link between deposit and payment is hidden by the pool, as well as the pool is used |
| The agent's own chain provider | Not used | The deposit wallet, every one-time address and every seller payment |

## 4. Findings

| Finding | Needs a dishonest party | What happened |
|---|---|---|
| With a lost store and the same seed, the SDK used a note secret again. The new note carried a spent nullifier and was locked for good | No | Fixed. The SDK syncs before a deposit and skips used secrets. Proven on Preprod with the store moved away |
| A copy of a deposit's precommitment and refund key, absorbed first, took over the SDK's record. The owner's real note was then locked | A third party, at its own cost | Fixed. The SDK follows the exact output of a deposit it sent itself |
| After a lost reply the relayer called a settlement failed although it could still land. The SDK then dropped its record of the change note | No | Fixed. The relayer answers `uncertain`, and the SDK releases a note only on a known refusal |
| The SDK checked the protocol fee against a rate that the indexer reported. The chain bounds the fee only from below, so an operator of indexer and relayer could take most of a note | Operator | Fixed. The SDK reads the rate from the chain with its own provider |
| The SDK accepted any deadline in a quote, so a relayer could keep a note reserved | Operator | Fixed. A quote must expire within 15 minutes of the tip |
| The start state of the pool is not enforced on chain. A deployer could plant a second root, a fee balance or a negative fee rate | Deployer | Open. Before outside deposits |
| The proving keys come from one party | Deployer | Open. Before outside deposits |
| A settle without a named relayer leaves its surplus to whoever submits it | No | By design. The SDK always names the relayer |
| A public exit reveals the payments of its deposit by subtraction | No | By design, as on Base |
| The agent's chain provider sees the whole path | Provider | Open. An agent needs its own node for privacy from the provider |
| After a lost store the one-time addresses repeat | No | Open. It links payments and loses nothing |
| A repeated x402 request after an unclear answer pays again | No | Open |
| The privacy defaults of SPEC 13.2 are not built | No | Open |
| Ragequit needs the config output as a reference input, and the root history holds 16 roots | Admin or a flood of Inserts | Open. It can delay, not take |

## 5. What a user feels

| | Base | Cardano today |
|---|---|---|
| Time for one payment | 7 to 15 seconds | 69 to 116 seconds on Preprod |
| Cost on top of the price | About a cent of gas, paid by the operator | About 1.2 ADA: 1 ADA for the relayer and 0.17 ADA for the second transaction |
| Smallest payment | 0.001 USDC | About 1 ADA, the minimum output of the ledger |
| Asset | USDC | ADA |
| Pool actions | Many in one block | About one in each block |
| Not built here | | MCP server, agent spend limits, sanctions screening, recovery of change notes from the seed, gasless deposit, payment memory per request |

The Base numbers come from the documents of the Base implementation. The Cardano numbers are in [measurements.md](./measurements.md).

## 6. Limits of this check

- The 0xbow circuit sources are not in the Base repository, only compiled artifacts. The Base side of the circuit rules was read from the contracts and the proof layout.
- Nobody checked the Poseidon constants again. Tests compare the circuit library with the TypeScript library.
- Nobody checked that the deployed keys match the circuit sources, or the setup itself.
- The trie library was read only where the pool uses it.
- These were reads of the code by the build team and its tools. They are not an audit.
