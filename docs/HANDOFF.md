# Handoff: start here

| Field | Value |
|---|---|
| For | The engineer who builds zBase Cardano |
| From | Marcus |
| Date | 2026-10-06 |
| State of the repo | M0 runs on Preprod. Public landing page and documentation reader are built. Mainnet is not deployed yet |

## 1. What you are building

zBase Cardano lets an AI agent pay on Cardano mainnet without showing which wallet paid.
The agent deposits into a shared pool, then pays from the pool with a zero-knowledge proof.
The first release is a capped ADA pool for team funds, called M0.
It adapts zBase, which runs on Base today, to Cardano's limits.

## 2. Read in this order

| # | Document | Time | Why |
|---|---|---|---|
| 1 | [PRD.md](./PRD.md) | 15 min | What we build, for whom, and what is out of scope |
| 2 | [SPEC.md](./SPEC.md) | 60 min | The design. Sections 4 to 7 are the rules you implement |
| 3 | [TEST-VECTORS.md](./TEST-VECTORS.md) | 10 min | Known answers your code must reproduce |
| 4 | [TEST-PLAN.md](./TEST-PLAN.md) | 15 min | Every test, with a stable ID |
| 5 | [PLAN-M0.md](./PLAN-M0.md) | 20 min | Work packages, interfaces, and done criteria |
| 6 | [SETUP.md](./SETUP.md) | 10 min | Tools, versions, and known pitfalls |
| 7 | [RUNBOOK-M0.md](./RUNBOOK-M0.md) and [CEREMONY.md](./CEREMONY.md) | 15 min | How M0 goes to mainnet |
| 8 | [research/](./research/) | as needed | The evidence behind each number |

[AGENTS.md](../AGENTS.md) holds the hard rules. Read it before you write code.

## 3. What is decided

The owner approved the design on 2026-10-06. SPEC section 2 lists each decision with its reason. The main ones:

- Groth16 over BLS12-381, with circom and snarkjs.
- The Privacy Pools note model, the same as zBase on Base.
- The validator never computes Poseidon. A second proof covers each tree update.
- Deposits are ordinary payments. Anyone can insert them with a proof.
- Spent notes are tracked in one Merkle Patricia Forestry root.
- Stealth mode is the default x402 path: the pool pays a one-time key, and that key pays the seller.
- The agent proves on its own machine.
- Scripts are immutable. The admin can only pause deposits and tune bounded values.

## 4. What is verified and what is assumed

| Claim | Status | Where |
|---|---|---|
| A Groth16 check fits a transaction (about a quarter of the CPU limit) | Measured | research/2026-10-06-measurements.md |
| On-chain Poseidon does not fit (1.27B CPU per hash) | Measured | Same file |
| Live mainnet limits and prices | Read from the chain on 2026-10-06 | research/data/koios-mainnet-epoch-params.json |
| A snarkjs proof on `bls12-381` verifies in Aiken after conversion | Verified in an Aiken test | research/spikes/groth16-pipeline |
| Poseidon255 in circom equals the TypeScript library | Verified, 26 of 26 checks | research/spikes/poseidon-vectors |
| The trie library compiles with Aiken 1.1.24 | Verified | Same pipeline spike |
| An input of `x + r` verifies when the range check is missing | Verified by a control test | Same pipeline spike |
| Label and context encodings | Defined, with vectors from a reference script | TEST-VECTORS sections 6 and 7 |
| The stock TypeScript x402 facilitator accepts the stealth payment | Verified on Preprod, four runs through the stock seller | measurements.md, section 3 |
| Fees of about 1.0 to 1.2 ADA per private payment | Measured on Preprod: 0.85 ADA for the two legs, plus a share of one Insert | measurements.md, sections 3 and 5 |
| Circuit sizes | Measured: spend 16,828, insert 62,950 and ragequit 8,423 constraints | measurements.md, section 1 |
| Mesh can build the Settle transaction | Verified on Preprod. Two defects of Mesh 1.9.1 are worked around in `packages/txlib` | AGENTS.md, Cardano knowledge |
| The community powers of tau file is usable | Not verified | CEREMONY section 2 |

The three circuits, the validators, the services and the SDK are written and run on Preprod.
Nobody outside this project has reviewed the design or the code.

The public frontend is in `apps/web`. It explains the design, distinguishes Preprod from mainnet, and marks the project as `In development`.
Its main action, `Read docs`, opens `/docs/`, which renders the current PRD, SPEC, and M0 plan.
It has scroll-driven character motion, a dual-terminal walkthrough, a visual privacy boundary, a six-node payment path, a subtle automatic headline light sweep, and a scenic footer.
The terminal and orbit scenes stay pinned through their scroll sequences when their content fits the viewport. Compact screens retain readable manual controls.
The pause control and reduced motion setting keep every section readable.
It has no wallet connection or transaction functions. See SPEC 8.10 and tests FE-01 to FE-16.

To work on the frontend, run these commands from the repo root:

```sh
npm ci
npm run dev
npm test -w apps/web
npm run build
```

`npm test -w apps/web` runs the frontend checks. `npm test` runs all workspace tests.

## 5. Where the build stands

M0 is built. On 2026-10-06 the whole product ran on the Preprod test network.

What works, with tests and a live run:

- The three circuits, with a key setup for development and one per network.
- The pool validator with all four actions, and the deposit, config, association set and token validators. 354 Aiken checks.
- The transaction builders, a Blockfrost provider, and a local test chain that runs the real validators and the ledger rules that bit us on the live network.
- The indexer, the crank, the association set provider service and the relayer, as one node.
- The agent SDK with the stealth x402 signer.
- Deploy, the demo and the admin command. [RUNBOOK-PREPROD.md](./RUNBOOK-PREPROD.md) has the commands.
- More than 980 JavaScript tests. The test in `ops/test/rehearsal.test.ts` plays the whole story through real HTTP.

What is left before the mainnet canary:

1. A mainnet Blockfrost project and a funded operator key. Then the commands of the Preprod runbook with `NETWORK=mainnet`.
2. A key setup with several parties, before anyone outside the team deposits. [CEREMONY.md](./CEREMONY.md) describes it. The setup command in this repository has one party.
3. The proving keys of a pool are not in the repository. Publish them, for example as release files, so that other people can use the pool.
4. The solvency monitor of the runbook is not built.

Known limits of M0, each a deliberate cut:

- The relayer does not chain transactions. One pool transaction confirms before the next is built, so the pool serves about one action per block.
- A payout with a datum hash is refused by the Settle builder.
- A change note cannot be recovered from the seed alone. The SDK needs its store file.
- The association service approves every absorbed deposit at once, unless a deny function refuses it. No screening data source is connected.
- The indexer treats confirmed data as final. It does not wait for a number of blocks.
- A deploy that stops midway has no resume command. Section 9 of the Preprod runbook says what to do.
- `npm audit` reports findings in packages that the Cardano libraries pull in. None was reviewed.

Your first day:

1. Do [SETUP.md](./SETUP.md) and confirm every version check.
2. Run `npm ci`, `npm run build:circuits`, `npm run setup:dev` and `npm test`.
3. Read `ops/test/rehearsal.test.ts`. It shows every part working together.
4. Follow [RUNBOOK-PREPROD.md](./RUNBOOK-PREPROD.md) once with your own pool.

### Decisions made during the build

The build made these choices where the plan was silent or wrong. Each one can be changed, at the cost given.

| Decision | Why | Cost of changing it |
|---|---|---|
| Aiken and circom come from npm packages, not from global installs | One `npm ci` gives every tool at a pinned version | Small changes to the scripts |
| Tests run on a local chain that evaluates the real validators with the pinned Aiken | No pool exists on a network before deploy, and CI must not need one | None. The provider adapter has its own tests |
| The local chain learns every ledger rule that failed on a live network | A local chain that skips a rule hides exactly the bugs that rule exists for | None |
| Script parameters are applied with the Evolution SDK, not with Mesh | Mesh 1.9.1 cuts byte strings over 64 bytes | None. A test compares all five scripts with the Aiken CLI |
| The circuits use their own small gadgets, never circomlib | circomlib gadgets assume another field | About 40 lines of circom to audit |
| The insert circuit takes its slots as one public array | Three arrays would give another order of public signals | A new key setup |
| The prover is its own package | The crank proves, the relayer verifies, and the fixtures prove too | None |
| The continuing pool output must carry no reference script (rule P3) | Otherwise anyone could park a large script on the pool output and raise the fee of the next spend | One equality check in the validator |
| The token names are fixed (`pool`, `config`, `asp`), so the genesis is checked off chain | The Spec says so. M0 uses the team's own funds | For M1, bind the names to the seed output. That means a new pool |
| The development verification keys are in git under `artifacts/dev` | The pool script takes the keys as parameters, and CI has no proving keys | None. A live pool never uses them |
| Each network gets its own key setup, with keys outside the development folder | A test key must never be mistaken for a live key | None |
| Tests that need a proving key skip without one | CI has no proving keys | A proving regression can reach main if nobody runs the tests locally |
| The relayer fee is limited in the SDK, 2 ADA by default | The validator fixes only the protocol fee, and the proof fixes the withdrawn amount | A relayer that needs more is refused until the caller raises the limit |
| The SDK settles its own tentative marks by deadline | A deadline needs no extra chain reads and cannot give a false answer when the indexer lags | A dropped transaction is noticed up to 12 minutes late |
| The indexer reads a new block a second time only for two minutes after a change | A provider can serve old data right after a block, and a second read of every block would nearly double the requests of an idle node | Outside those two minutes, only the next block corrects a stale read |
| The first live run was on Preprod | The owner asked for it. All off-chain code takes a network setting | None. Mainnet uses the same code |

## 6. Hard rules

These are the mistakes that lose funds or break privacy. [AGENTS.md](../AGENTS.md) has the full list.

- Range-check every public input on-chain: `0 <= x < r`.
- Never compute Poseidon in a validator.
- Never use `circomlibjs`. Use the two Poseidon255 libraries named in the Spec.
- Never spend a per-deposit UTXO at payment time. Funds sit in the one pool UTXO.
- Never accept a tree root without a proof.
- No pool transaction mints, withdraws rewards, or carries a certificate.
- Never submit a mainnet transaction that fails evaluation.
- Never commit a seed phrase, a signing key, or a proving key.

## 7. Decisions that need the owner

None blocks M0. PRD section 14 lists each question, its default, and when it must be decided.
The first ones to come due are the compliance data source and the operating entity. Both are needed before M1.

Ask the owner before you change any of these:

- A rule in SPEC sections 4 to 6.
- A cap, a fee bound, or an admin power.
- The x402 mode order.
- Anything that adds an operator who must be trusted.

## 8. Where things come from

| Thing | Location |
|---|---|
| zBase on Base, the source architecture | `github.com/goheesheng/zBase` |
| Privacy Pools reference contracts and circuits | `github.com/0xbow-io/privacy-pools-core` |
| The Poseidon255 circuits | `github.com/jmagan/poseidon-bls12381-circom` |
| The x402 scheme for Cardano | `github.com/x402-foundation/x402`, `specs/schemes/exact/scheme_exact_cardano.md` |
| A defensive Aiken Groth16 verifier to learn from | `github.com/ODATANO/DAYZERO` |
| A project that proves a Merkle append in-circuit on preprod | `github.com/TrustLevel/ZK-Defi-Protocol` |

## 9. Limits of this handoff

- The plan is a work breakdown. It fixes interfaces and tests, not line-by-line code.
- Estimates are marked as estimates. M0 replaces them with measurements.
- The design is new. An external audit is required before the caps are lifted.
- This repo uses the MIT license. zBase on Base uses Apache-2.0.
