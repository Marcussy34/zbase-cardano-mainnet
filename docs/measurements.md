# zBase Cardano: Measurements

Fill this file during M0. It replaces the estimates in [SPEC.md](./SPEC.md) section 10.
Measured values that are already known are in [research/2026-10-06-measurements.md](./research/2026-10-06-measurements.md).

## 1. Circuits

| Circuit | Constraints | Setup power | Proving time | Proving key size |
|---|---|---|---|---|
| `spend` | 16,828 | 15 | 1.5 to 1.9 s | 14,285,885 bytes |
| `insert` | 62,950 | 16 | 4.3 to 4.8 s | 47,067,202 bytes |
| `ragequit` | 8,423 | 14 | 1.0 s | 7,141,180 bytes |

The setup power is the smallest one that fits the circuit. snarkjs needs one row per constraint, one per public signal, and one more.
One shared powers of tau file of power 16 serves all three circuits. Its size is 113,248,170 bytes.
The proving key sizes are for the development keys.
Proving times were measured on an Apple M2 Max with Node 24.10.0 and snarkjs 0.7.6, while other builds ran. Each time covers the witness, the proof, and a check of the proof.

## 2. Scripts

| Script | Size in bytes | Size with parameters applied | Script hash |
|---|---|---|---|
| `pool` | 10,072 | 12,659 | |
| `deposit` | 484 | 518 | |
| `config` | 1,760 | 1,794 | |
| `asp` | 1,219 | 1,254 | |
| `nft` | 456 | 499 | |

Measured on 2026-10-06 with Aiken 1.1.24 and the development verification keys. The pool script takes the three verification keys as parameters, which adds about 2,600 bytes.
The pool script fits one publication transaction (limit 16,384 bytes). Its reference output locks 55.5 ADA at the current price per byte.
Script hashes depend on the deployment and are filled in after the live run.

## 3. Transactions on mainnet

| Transaction | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | | | | | |
| Refund | | | | | |
| Insert, 1 deposit | | | | | |
| Insert, 1 note | | | | | |
| Insert, 4 slots | | | | | |
| Settle, 1 payout | | | | | |
| Settle, 4 payouts | | | | | |
| Ragequit | | | | | |
| Stealth leg 2 | | | | | |
| ASP update | | | | | |
| Config update | | | | | |

### Transactions on the local test chain

Measured on 2026-10-06 in `packages/txlib/test/flow.test.ts`, with the real validators, real proofs, and Preprod parameters.
Execution units include the 10 percent margin that the builders add. Sizes include signatures.

| Transaction | CPU steps | Memory units | Size in bytes | Fee in ADA |
|---|---|---|---|---|
| Deposit | none | none | 350 | 0.170781 |
| Refund | 9,549,351 | 30,049 | 478 | 0.186606 |
| Insert, 2 deposits | 3,561,283,645 | 1,062,749 | 990 | 0.714686 |
| Insert, 1 note | 2,882,288,665 | 775,150 | 885 | 0.636746 |
| Settle, 1 payout | 3,223,990,487 | 886,982 | 1,243 | 0.683587 |
| Settle, 4 payouts | 3,354,760,372 | 1,219,493 | 1,555 | 0.725929 |
| Ragequit | 2,854,798,448 | 676,089 | 1,312 | 0.647836 |
| Stealth leg 2 | none | none | 203 | 0.165961 |
| ASP update | 61,407,529 | 178,537 | 600 | 0.215321 |

So one private payment in stealth mode costs about 0.85 ADA in network fees for its two legs, before the relayer fee.

### Transactions on Preprod

The Preprod pool was deployed on 2026-10-06. Its record is [deployments/preprod.json](../deployments/preprod.json).

| Transaction | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Plain x402 payment, no pool | none | none | 281 | 0.169021 | `a185ee503b7a43e9faf67ea112f3adc05ffe3df5825b4b8512ad8d6a2c839a76` |
| Fund the role keys | none | none | 571 | 0.180549 | `b99438ad408efecccffc77e9cf866e4fd013ee165aa0fe0060fceda939a0ca42` |
| Publish the pool script | none | none | 12,947 | 0.725093 | `a9b1c5863c47a4bbf40448914192f893be139901a7f9c34c095f1073c89d1215` |
| Publish the deposit, config, and ASP scripts | none | none | 3,954 | 0.329401 | `0a57eac8b52fea26a1ebd71c82b34c0d1b91da824017a066a9389d45485dadbb` |
| Init | 34,513,558 | 107,826 | 1,439 | 0.227451 | `db87709baae198b5de44a8115b8f2a931fe0ca4d94142943615b7ba142ac523f` |
| Deposit | none | none | 349 | 0.170781 | `ea0c386124bc7a621850dbcc6604da672e9ea2f56244ea09d6582647e6a6380c` |
| Refund | 9,549,351 | 30,049 | 477 | 0.186606 | `6cc784d3785f8a41b44119f0cbd9016b16125f10f81dce35d175a0e98a6c6e58` |
| Insert, 1 deposit | 3,096,717,864 | 972,831 | 937 | 0.673714 | `8f6fa4b314995a5094a87ad5622fd2d85561d9305fdf946654cd8f567dfbc72f` |
| ASP update | 64,242,754 | 182,820 | 599 | 0.215772 | `4411baa60102d65d4d267469fdc7d24751278c2af79cc72cc95c68335058d1ff` |
| Settle, 1 payout to a one-time address | 3,224,181,642 | 887,490 | 1,242 | 0.683630 | `a65f39df751aa7843906799080d9520bbafb6a123e1730df354d9d06782632e4` |
| Stealth leg 2, one-time address to the seller | none | none | 196 | 0.165697 | `6043b7ec6e7fe3d98082081878ca66352ec0506405e36f1f9d33bce321bc9246` |
| Insert, 1 note | 2,887,382,131 | 792,574 | 884 | 0.638118 | `1e7c759350fef8ae0f4b74ce74eb34ad97057c7ac2b74c96ea25467fbfa571f0` |
| Ragequit | 2,864,233,950 | 699,948 | 1,174 | 0.643865 | `31e91180001495a39c500c4c29aba3a8d0bbe54237365ff41a7880ca760ec763` |

A deployment costs about 245 ADA: 160 ADA of role funding, 73.6 ADA locked in the four reference script outputs, 8.9 ADA in the three state outputs, and about 1.5 ADA of fees.
The Init units are the evaluated units before the 10 percent margin.

The first Init on Preprod was finished by hand, after the node refused it for a wrong script integrity hash.
That defect is fixed in `packages/txlib` (live cost models).
To prove the fix, the complete deploy function ran once more on Preprod on 2026-10-06 with the final code, as a rehearsal for mainnet.
All four transactions were accepted on the first try, and the run took 201 seconds.
That second pool is a rehearsal and is not recorded in this repository.

| Rehearsal transaction | Transaction hash |
|---|---|
| Fund the role keys | `8706c1a3537f111999d2fb6d1c3c67d418a187c0c63a3a14a10c3bc079199c6a` |
| Publish the pool script | `7be7af7699930f49b715e2f854f1a19a6a6e54524ef87c843ef762d6f1e285c0` |
| Publish the deposit, config, and ASP scripts | `7e2c0d74c0b838eb604c352ae782825486efa710ecf0f8ef664682f4bb665180` |
| Init | `7b156beead8160f683a932cb964d896bf5f7174f7a9decc56f04a6c5abcd7adc` |

The rows from Deposit to Ragequit are one complete pool story, run on 2026-10-06 with the code of this repository.
The indexer, the crank, the association set provider service and the relayer ran in one process against Blockfrost.
The sizes, fees and units in those rows are the values that the chain recorded.
A deposit of 10 ADA was credited as 9.7 ADA. A private payment of 2 ADA reached the seller from a one-time address.
The change note of 6.534303 ADA then left the pool through Ragequit.
For the same shape of transaction, the live units of Refund, Settle, Insert of 1 note and Ragequit are within 0.4 percent of the local test chain.
The association update is 5 percent higher on Preprod.
So one private payment in stealth mode cost 0.849327 ADA in network fees for its two legs, before the relayer fee of 1 ADA.

### The demo through the node and the stock x402 seller

On 2026-10-06 the node (`npm run node -w ops`), the example seller with the stock x402 server and facilitator, and the demo (`npm run demo -w ops`) ran as three processes against Preprod.
The demo ran twice with the same note store. Both runs ended with HTTP 200 and the weather body.
The agent paid through the stock x402 client with the SDK's stealth signer. The stock facilitator checked and submitted the second leg.

| Transaction, first run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | none | none | 349 | 0.170781 | `188f2b64754228e1088f36cc68f63e35fca5b8cf42102791b8748471eefcd549` |
| Insert, 1 deposit | 3,245,199,950 | 989,153 | 1,007 | 0.688442 | `f96c4e1ce6c990704fe952fe3dd48839d7449d2f19b9941a9588533a154bca1d` |
| ASP update | 61,407,529 | 178,537 | 599 | 0.215321 | `c77106998cfd1b6f0aa00a04ad1476667566241e1d99b8021d1430b2a4cf2360` |
| Settle, 1 payout to a one-time address | 3,258,408,716 | 999,972 | 1,451 | 0.701784 | `860faa892eff5205f6e1e6d60615837926c6eeb719d338163499a8a0b28f151e` |
| Stealth leg 2, submitted by the stock facilitator | none | none | 202 | 0.165961 | `8295a36bb5111c94abc09d783552aac07ddd73769e5c9f42bca6b07f74fb39cf` |
| Insert, 1 note | 2,892,116,632 | 807,226 | 954 | 0.642385 | `9d25ba585f7eb9ef06162ce420808122c540a3af9a039ce28be1686ca97e1426` |
| Ragequit | 2,890,256,226 | 786,824 | 1,383 | 0.659950 | `3c9937b3ac020e23122c7d034640dd16afa13fd15242859818fbb1caf5020af4` |

| Transaction, second run | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Deposit | none | none | 349 | 0.170781 | `15d64d2341f166cecb5aa70e65949cd3accad4dbd825d2c06a6ec287c7eb2903` |
| Insert, 1 deposit | 3,249,934,452 | 1,003,805 | 1,077 | 0.692708 | `9f36ba4c0f568f4596fe1478e66b8688699a6eba95fd6fe19533896431d29c07` |
| ASP update | 61,407,529 | 178,537 | 599 | 0.215321 | `dc50a6fd31020cc8fcdf42398d7f84c8e8547db02b82f474250a1f3e2fb66eb8` |
| Settle, 1 payout to a one-time address | 3,257,548,858 | 1,001,622 | 1,522 | 0.704941 | `fdf36cc2f51bdfd700df5dad651fe8c303807200df280b7e6659b81ec1a7d381` |
| Stealth leg 2, submitted by the stock facilitator | none | none | 202 | 0.165961 | `25232740f5bb6b297895e65184fd25cb55478752bd7885a5b4dd9f4c35c453d7` |
| Insert, 1 note | 2,899,686,358 | 826,161 | 1,025 | 0.647147 | `26c06f86d6d4b41d8a91b60d1b484ff360a9901d6e0e9a26362770d6e1d8a1c3` |
| Ragequit | 2,890,173,640 | 789,871 | 1,454 | 0.663244 | `051fd479d1a35b6310cfc5314de9d5323add552f097f845ea7f3ee7c750308d3` |

Transactions grow by a few bytes as the pool ages, because the proof of a new nullifier gets longer with every spent note.

### Admin transactions on Preprod

Run on 2026-10-06 on the rehearsal pool with `ops/src/admin.ts`.

| Transaction | CPU steps | Memory units | Size in bytes | Fee in ADA | Transaction hash |
|---|---|---|---|---|---|
| Config update, pause deposits | 82,889,536 | 236,548 | 737 | 0.234389 | `462a3a1c32b1c2c46b7de4dfe5855c39fd9925d3a4c81b21ecf47eebc871c437` |
| Config update, unpause deposits | 82,889,536 | 236,548 | 737 | 0.234389 | `b8bca7aac78b8a24baa865e50d34ae22852639e38194abd9ff29c43d07ab2986` |
| Sweep of 4 reference script outputs | none | none | 508 | 0.421152 | `1b7e85e2798319cdd4b54efa8aa09a1819f5b23c8c6fef9c6a9fac3e0a108c52` |

The sweep returned 73.55015 ADA to the operator. Its fee is higher than a plain payment because the ledger charges for the bytes of every reference script on a spent input.

## 4. End-to-end timings

| Flow | Time from request to one confirmation |
|---|---|
| Stealth payment, one-time key funded on demand | 116.0 s and 110.2 s on Preprod, two runs |
| Stealth payment, one-time key funded ahead | not built in M0 |

The time runs from the request to the seller until the seller answers HTTP 200.
It covers the proof, the settlement by the relayer, one confirmation of the first leg, the second leg, and its check and one confirmation by the stock facilitator.

### The demo on Preprod, step by step

Both runs of the demo command from section 3. Times are in seconds.

| Step | First run | Second run |
|---|---|---|
| Deposit submitted | 3.6 | 2.9 |
| Note spendable, from the start | 119.0 | 163.7 |
| First leg confirmed, from the payment request | 28.9 | 26.9 |
| Seller answered HTTP 200, from the payment request | 116.0 | 110.2 |
| Change note spendable, after the seller answered | 0.0 | 6.1 |
| Exit submitted, after the change was spendable | 9.0 | 9.0 |
| Exit confirmed, after the change was spendable | 19.5 | 75.0 |
| Whole demo | 254.5 | 355.0 |

Waiting for blocks dominates every step. The longest single wait, 75 seconds for the exit of the second run, was one slow block.

### Step timings on Preprod

One sample each, from the pool story in section 3, run step by step on a laptop that was busy with other work.
Preprod makes a block about every 20 seconds.

| Step | Work before submission | Wait for one confirmation |
|---|---|---|
| Deposit | 1.8 s to build | 27.8 s |
| Insert of 1 deposit by the crank | 14.3 s to read, prove, build and submit | 33.8 s |
| Association update | 6.3 s to read, build and submit | 49.1 s |
| Private settlement by the relayer | 1.9 s to prove, 7.0 s to verify, build and submit | 27.6 s |
| Stealth leg 2 | under 1 s to build | 39.4 s |
| Insert of 1 note by the crank | 19.3 s to read, prove, build and submit | 22.7 s |
| Ragequit | 4.2 s to prove, 5.6 s to build | 33.1 s |

From the block of the deposit to the block of the second stealth leg, 224 seconds passed.
That covers the deposit, its insertion, its approval, the private settlement and the payment to the seller, each started by hand after the previous one confirmed.
An indexer that starts cold replayed this history of five pool transactions in about 10 seconds.

## 5. Differences from the Spec estimates

No estimate in SPEC section 10.3 was wrong by more than 20 percent.

| Transaction | Estimated CPU | Measured CPU | Estimated fee in ADA | Measured fee in ADA |
|---|---|---|---|---|
| Deposit | none | none | 0.17 to 0.20 | 0.170781 on Preprod |
| Insert, 4 notes | about 2.9B | 3.08B in the validator tests | 0.60 to 0.70 | 0.638118 for 1 note on Preprod |
| Insert, 4 deposits | about 4.1B | 4.26B in the validator tests | 0.75 to 0.90 | 0.714686 for 2 deposits on the local chain |
| Settle | about 2.9B | 3.22B on Preprod | 0.65 to 0.80 | 0.683630 on Preprod |
| Ragequit | about 2.6B | 2.86B on Preprod | 0.60 to 0.75 | 0.643865 on Preprod |
| Stealth leg 2 | none | none | 0.17 to 0.20 | 0.165697 on Preprod |

Settle and Ragequit use about 10 percent more CPU than estimated, and both stay under a third of the transaction limit.
The Spec estimated 1.0 to 1.2 ADA for one private payment in stealth mode, counting a quarter of an Insert.
The measured two legs cost 0.849327 ADA. A quarter of the Insert of one note adds 0.16 ADA, which gives 1.01 ADA.
When a change note is inserted alone, the whole Insert of 0.638118 ADA belongs to that payment, which gives 1.49 ADA.

## 6. Contract building blocks

Measured in Aiken 1.1.24 unit tests on 2026-10-06. Each number includes the small cost of the test itself.

| Function | Case | CPU steps | Memory units |
|---|---|---|---|
| `groth16.verify` | 2 public inputs, both non-zero | 2,161,608,033 | 90,539 |
| `groth16.verify` | 2 public inputs, one of them 0 | 2,030,928,410 | 89,021 |
| `encoding.label` | one deposit | 5,815,539 | 11,279 |
| `encoding.context` | 1 payout | 20,442,216 | 49,829 |
| `encoding.context` | 4 payouts, each with a script credential, a stake credential, and a datum hash | 65,137,024 | 171,572 |
| `encoding.nullifier_key` | one key | 1,598,855 | 1,105 |
| `groth16.verify`, real `insert` proof | 15 public inputs, 9 of them 0 | 2,604,890,058 | 270,047 |
| `groth16.verify`, real `spend` proof | 6 public inputs | 2,700,200,044 | 150,443 |
| `groth16.verify`, real `ragequit` proof | 4 public inputs | 2,430,918,152 | 120,491 |

Whole runs of the pool validator, measured in Aiken tests with real proofs. The limit for one transaction is 10,000,000,000 CPU steps.

| Action | Case | CPU steps | Memory units |
|---|---|---|---|
| Insert | 4 deposits | 4,259,066,560 | 1,303,951 |
| Insert | 4 queued notes | 3,083,043,009 | 959,424 |
| Settle | 4 payouts, queue of 7, trie proof of 5 levels | 3,163,119,524 | 1,525,372 |
| Ragequit | a deposit note | 2,628,484,625 | 731,595 |

A skipped zero input saves 130,679,623 CPU. So one proof check costs about 1.90B CPU plus 0.131B for each non-zero public input.
That is close to the model in SPEC 10.2 (1.87B plus 0.13B).

## 7. Off-chain library

Measured on an Apple M2 Max with Node 24.10.0 on 2026-10-06.

| Operation | Result |
|---|---|
| One Poseidon255 `h2` call | about 0.17 ms |
| Append 200 leaves, then read the root once | 226 hash calls |
| Set one leaf, then read the root | 32 hash calls |

## 8. Development key setup

Measured on an Apple M2 Max with Node 24.10.0 and snarkjs 0.7.6 on 2026-10-06.
The machine ran other builds at the same time, so read the long steps as upper bounds.

| Step | Time |
|---|---|
| Compile the three circuits, forced | about 26 s |
| Compile the three circuits, nothing changed | about 1 s |
| Powers of tau, power 16: contribute | 44 to 51 s |
| Powers of tau, power 16: prepare phase 2 | 923 to 1,145 s |
| Powers of tau, power 16: verify | 17 s |
| Groth16 setup for `spend`, `insert`, `ragequit` | 71 s, 96 s, 46 s |
| Full setup, first run | 1,663 s |
| Setup when every key is cached | under 1 s |

Two forced builds gave the same R1CS files, so the circuit build is reproducible.

| Circuit | R1CS SHA-256 |
|---|---|
| `spend` | `f7cbe870ef2fa3897cc61f62ea3382617c4b5f7539421aee7c7809b96dae31cf` |
| `insert` | `c1fec5a85f5e84ce270cb327d0548f7a9bfeeb144067fa13494f86b41007c7ca` |
| `ragequit` | `ec97e315ebf705e07913f7de0dec0c9fd79423fbfe1e5c73c48de580bffde91c` |

The keys are not reproducible. snarkjs mixes 64 random bytes from the operating system into every contribution, even when the caller passes a fixed text.
So each machine gets its own development keys, and proof fixtures must carry the verification key they were made with.
