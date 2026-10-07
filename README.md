# zx402

Private payments for AI agents on Cardano. Live on the Preprod test network.

An agent deposits tUSDM into a shared pool once. Later it pays x402 sellers from the pool with a zero-knowledge proof. The chain shows the pool as the payer, not the agent's wallet, and nothing links the payment to the deposit.

**Status (2026-10-07):** live on Preprod. The pool `60279ebfb8db22bbe0cb2a1b7a61702ab36ade074a3866ac836df3ed` holds tUSDM, the Preprod stablecoin. With the code of this repository an agent funded the pool, paid a stock x402 seller 2 tUSDM in private through a one-time address and got the seller's answer back, and paid a [Masumi](https://www.masumi.network/) agent 0.01 tUSDM for a web-search answer. The proof is below, with every transaction on the explorer.

**Mainnet** is the next step and is not deployed. Before it takes outside funds it needs a key ceremony with several parties, an on-chain check of the pool's start state and an outside audit. Nobody outside this project has reviewed the design or the code yet.

**Documentation:** [docs.zx402.org](https://docs.zx402.org/) explains how it works in plain words and carries every document from `docs/`. Run it locally with `npm run docs:dev`. New here? Read [docs/HANDOFF.md](docs/HANDOFF.md) first.

## How it works

![A private payment: the wallet funds the pool in public, the pool pays a one-time address with a proof, the one-time address pays the seller through stock x402](docs/diagrams/private-payment.png)

1. **Deposit.** The agent sends tUSDM to the deposit script with a hidden commitment to a secret note.
2. **Approve.** The approval service checks the deposit and adds it to the approved set. Only approved deposits pay in private.
3. **Pay.** The agent proves in zero knowledge that it owns an approved, unspent note. The pool pays a fresh one-time address, and that address pays the seller with a plain x402 payment that any stock seller accepts.
4. **Change.** What is left becomes a new note in the pool. One deposit pays many times.
5. **Exit.** The depositor can always take the rest back in public with a signature. No service can block it.

The validators are written in Aiken. The circuits are Circom with Groth16 on BLS12-381. The off-chain code is TypeScript. The diagram source is `docs/diagrams/private-payment.excalidraw`.

## Proof from Preprod

This is the demo in its final shape: the pool was funded earlier, then one command makes one private payment and the seller answers. Everything below comes from the run of 2026-10-07 at 07:54 UTC on Cardano Preprod. The terminal output is in [docs/evidence/staged-demo-2026-10-07.log](docs/evidence/staged-demo-2026-10-07.log).

```text
$ npm run demo -w ops -- --reuse --no-exit
Seller asks 2000000 16a55b2a...0014df10745553444d for the weather
Note c5 in the pool covers the price plus fees 1000000 ...; no deposit
Private payment 6439e9c5eec05c2692995ab17c7164be38e068003ec832e21c51a1b1e427be6a confirmed in 21.182 seconds
Seller payment c493eeedb959bc091da233b0971bd1818faed68efca60ad324e263e3b5e57640 returned HTTP 200 in 96.562 seconds
Change c6 stays in the pool for the next payment
Demo complete in 99.706 seconds
What the chain shows, on the explorer:
  Pool            https://preprod.cardanoscan.io/address/addr_test1wpz3ul73ektd57lzg7glcuz8xs3767dyqs2e8duyltf0r6c2cpd4d
  Agent's wallet  https://preprod.cardanoscan.io/address/addr_test1vz8etvadesg5a9stprjnajwqwr3g4u4d4pd0dgx9cslc76ch39334
                  funded the pool earlier; it does not appear below
  Private payment https://preprod.cardanoscan.io/transaction/6439e9c5eec05c2692995ab17c7164be38e068003ec832e21c51a1b1e427be6a
                  the pool pays one-time address addr_test1vqtmda4r0wahacczv389p38xz5337w8uknjc5auxx0m7zjghjvmpl with a proof; no deposit is named
  One-time addr   https://preprod.cardanoscan.io/address/addr_test1vqtmda4r0wahacczv389p38xz5337w8uknjc5auxx0m7zjghjvmpl
  Seller payment  https://preprod.cardanoscan.io/transaction/c493eeedb959bc091da233b0971bd1818faed68efca60ad324e263e3b5e57640
                  the one-time address pays the seller addr_test1vrc63vsk9tuarc0ry4stx6j2k2myl7zqn4lx6x27psl5s7sez46cl through stock x402
  Seller          https://preprod.cardanoscan.io/address/addr_test1vrc63vsk9tuarc0ry4stx6j2k2myl7zqn4lx6x27psl5s7sez46cl
Not on the chain: any link from the agent's wallet or its deposit to the one-time address or the seller.
{"weather":"sunny","temperatureC":28}
```

The last line is the resource itself: the seller's answer, returned to the payer with HTTP 200 after the payment settled.

### What to check on the explorer

Each link opens on Cardanoscan and on cexplorer; the screenshots are from cexplorer.

| Step | What the page shows | Cardanoscan | cexplorer |
|---|---|---|---|
| The private payment (Settle) | Inputs: the pool script UTXO and the relayer's wallet. Outputs: the pool (3.99 tUSDM left, with the pool NFT), the relayer's change (its 1 tUSDM fee), and 2 tUSDM plus 2 ADA to a one-time address. The agent's wallet is nowhere in it. | [6439e9c5…](https://preprod.cardanoscan.io/transaction/6439e9c5eec05c2692995ab17c7164be38e068003ec832e21c51a1b1e427be6a) | [6439e9c5…](https://preprod.cexplorer.io/tx/6439e9c5eec05c2692995ab17c7164be38e068003ec832e21c51a1b1e427be6a) |
| The seller payment (leg 2) | One input, the one-time address. One output, the seller: 2 tUSDM plus 1.83 ADA. Submitted by the seller's stock x402 facilitator. | [c493eeed…](https://preprod.cardanoscan.io/transaction/c493eeedb959bc091da233b0971bd1818faed68efca60ad324e263e3b5e57640) | [c493eeed…](https://preprod.cexplorer.io/tx/c493eeedb959bc091da233b0971bd1818faed68efca60ad324e263e3b5e57640) |
| The one-time address | Created by the Settle at 07:54 UTC, emptied by the seller payment at 07:55 UTC, balance zero. Two transactions in its whole life. | [addr_test1vqtm…vmpl](https://preprod.cardanoscan.io/address/addr_test1vqtmda4r0wahacczv389p38xz5337w8uknjc5auxx0m7zjghjvmpl) | [addr_test1vqtm…vmpl](https://preprod.cexplorer.io/address/addr_test1vqtmda4r0wahacczv389p38xz5337w8uknjc5auxx0m7zjghjvmpl) |
| The agent's wallet | Its transactions are incoming funding, deposits into the pool and public exits from it. It never sent anything to the one-time address or to the seller. | [addr_test1vz8e…9334](https://preprod.cardanoscan.io/address/addr_test1vz8etvadesg5a9stprjnajwqwr3g4u4d4pd0dgx9cslc76ch39334) | [addr_test1vz8e…9334](https://preprod.cexplorer.io/address/addr_test1vz8etvadesg5a9stprjnajwqwr3g4u4d4pd0dgx9cslc76ch39334) |
| The seller's address | Receives 2 tUSDM from a fresh address each time. | [addr_test1vrc6…46cl](https://preprod.cardanoscan.io/address/addr_test1vrc63vsk9tuarc0ry4stx6j2k2myl7zqn4lx6x27psl5s7sez46cl) | [addr_test1vrc6…46cl](https://preprod.cexplorer.io/address/addr_test1vrc63vsk9tuarc0ry4stx6j2k2myl7zqn4lx6x27psl5s7sez46cl) |
| The pool | One script UTXO that holds every deposit's tUSDM and the pool NFT. | [addr_test1wpz3…pd4d](https://preprod.cardanoscan.io/address/addr_test1wpz3ul73ektd57lzg7glcuz8xs3767dyqs2e8duyltf0r6c2cpd4d) | [addr_test1wpz3…pd4d](https://preprod.cexplorer.io/address/addr_test1wpz3ul73ektd57lzg7glcuz8xs3767dyqs2e8duyltf0r6c2cpd4d) |

Why there is no link: the Settle carries a Groth16 proof whose public inputs are the pool's tree root, the approved-set root, a nullifier and the hash of the payment intent. The validator checks that proof. It never sees which note was spent, so the chain holds no path from any deposit to the one-time address. The proof and the note secrets are made on the agent's machine; the relayer only receives the proof and the intent.

**The private payment.** The pool and the relayer pay a one-time address. No wallet of the agent appears.

![The Settle transaction on cexplorer: inputs are the pool script and the relayer, outputs are the pool, the relayer's change and the one-time address](docs/evidence/settle-6439e9c5.png)

**The seller payment.** The one-time address pays the seller through the stock x402 flow.

![The seller payment on cexplorer: one input from the one-time address, one output to the seller with 2 tUSDM](docs/evidence/seller-payment-c493eeed.png)

**The one-time address.** First seen at 07:54 UTC, last active at 07:55 UTC, balance zero afterwards.

![The one-time address on cexplorer](docs/evidence/one-time-address.png)

**The agent's wallet.** Only deposits and exits; no payment to any seller.

![The agent's wallet on cexplorer](docs/evidence/agent-wallet.png)

### The Masumi purchase

The same pool paid a Masumi agent on Preprod, "Expose: Web Single Answer", 0.01 tUSDM for a one-sentence answer with three cited sources. Masumi agents are paid through a Masumi payment service node that locks the price in Masumi's escrow from its own purchasing wallet; the pool funded that wallet in private with one Settle ([9d22cf8a…](https://preprod.cardanoscan.io/transaction/9d22cf8a3fd678be5019b11bc9bae450e751796e45acd972f970572b81ad3439)), the node locked the escrow ([21b0de05…](https://preprod.cardanoscan.io/transaction/21b0de05e35f0c1a5a8bd7dfadb666bc7fb4730fd2be2fc856d78eac328a0d6c)), and the agent answered. The full record, with sizes, fees and execution units read back from the chain, is in [docs/measurements.md](docs/measurements.md).

![Paying a Masumi agent from the pool: the pool funds the Masumi node's purchasing wallet in private, then Masumi locks the escrow and the agent answers](docs/diagrams/masumi.png)

## Run the demo

```sh
npm run node -w ops                                              # indexer on 4010, relayer on 4011, crank, ASP
SELLER_ADDRESS=<address> npm run seller -w examples/x402-seller  # a stock x402 seller on 4021, 2 tUSDM per forecast
npm run demo -w ops                                              # deposit 10 tUSDM, pay, exit the change
npm run demo -w ops -- --no-exit                                 # stage: deposit and pay, keep the change in the pool
npm run demo -w ops -- --reuse                                   # live: pay from a note already in the pool, no deposit
npm run masumi -w ops -- --agent <registry asset> --input '{"question":"..."}'   # pay a Masumi agent
```

The demo prints every transaction hash and the explorer links shown above. [docs/RUNBOOK-PREPROD.md](docs/RUNBOOK-PREPROD.md) has the full procedure, from keys to deploy.

## Try it from source

1. Install the tools: `npm ci`
2. Run the tests: `npm test`
3. Compile the circuits and make the development keys: `npm run build:circuits`, then `npm run setup:dev`
4. Run the tests again. The tests that need proofs no longer skip.

Step 3 takes about 30 minutes the first time. Without it, every test that needs a proving key skips with a clear message.

## The pieces

![The zx402 system: the agent SDK, the one-process node, any x402 seller, and the pool on Cardano](docs/diagrams/system.png)

| Folder | What it holds |
|---|---|
| `apps/web` | The public landing page, [zx402.org](https://zx402.org) |
| `apps/docs` | The documentation site, built with Nextra and published to GitHub Pages |
| `circuits/` | The three circom circuits: spend, insert and ragequit |
| `contracts/` | The Aiken validators: pool, deposit, config, association set, and the token policy |
| `packages/crypto` | Hashes, notes, trees, encodings and key derivation |
| `packages/prover` | Proving and verifying with snarkjs |
| `packages/txlib` | Transaction builders, the Blockfrost provider, and a local test chain that runs the real validators |
| `packages/api` | The HTTP contracts of the indexer and the relayer, with clients |
| `packages/sdk` | The agent SDK, `@zx402/core`, with the stealth x402 signer |
| `services/` | The indexer, the crank, the association set provider service and the relayer |
| `ops/` | Key setup, deploy, the one-process node, the demo, the Masumi command and the admin command |
| `examples/x402-seller` | A stock x402 seller that knows nothing about the pool |
| `deployments/` | The record of the Preprod pool, its verification keys, and the retired pools |
| `docs/diagrams`, `docs/evidence` | The Excalidraw diagrams and the explorer screenshots of the live runs |
| `artifacts/` | Development verification keys and the order of public signals |

## Run the frontend

The landing page is in `apps/web`. Run these commands from the repo root:

```sh
npm ci
npm run dev
npm test -w apps/web
npm run build
```

Its "Read docs" buttons open the documentation site. The page has no wallet connection or transaction functions.

## Documents

| Document | What it covers |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | Start here: reading order, what is decided, what is verified, first tasks |
| [docs/PRD.md](docs/PRD.md) | Product requirements: users, scope, requirements, releases, risks |
| [docs/SPEC.md](docs/SPEC.md) | The design: cryptography, circuits, validators, transactions, x402 modes |
| [docs/PLAN-M0.md](docs/PLAN-M0.md) | Build plan of the first release: work packages and interfaces |
| [docs/TEST-PLAN.md](docs/TEST-PLAN.md) | Every test, with a stable ID, mapped to the Spec rules |
| [docs/TEST-VECTORS.md](docs/TEST-VECTORS.md) | Known answers for hashes, encodings, and proofs |
| [docs/SETUP.md](docs/SETUP.md) | Tools, versions, and known pitfalls |
| [docs/RUNBOOK-PREPROD.md](docs/RUNBOOK-PREPROD.md) | Run the whole product on the Preprod test network, with the exact commands |
| [docs/RUNBOOK-M0.md](docs/RUNBOOK-M0.md) | Step-by-step mainnet canary, for later |
| [docs/CEREMONY.md](docs/CEREMONY.md) | The Groth16 setup ceremony |
| [docs/measurements.md](docs/measurements.md) | Measured costs, and every transaction of the Preprod runs |
| [docs/research/](docs/research/) | Evidence: measurements, research digests, and two verified spikes |
| [AGENTS.md](AGENTS.md) | Hard rules for people and AI agents |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow and pull request checklist |

## The design in five lines

1. Notes live as commitments in a Poseidon Merkle tree. Funds sit in one pool UTXO.
2. A Groth16 proof over BLS12-381 authorizes every private payment.
3. The validator never hashes Poseidon. A second proof covers every tree update.
4. Spent notes are tracked in a Merkle Patricia Forestry root.
5. Payments reach stock x402 sellers through a one-time key (stealth mode).

## What fits and what does not

- It fits payments of a few tUSDM or more, and private funding of escrows, payment channels, and tabs.
- It does not fit cent-sized payments settled one by one. Cardano makes every output carry about 1 ADA, which the relayer attaches to each payout.
- What the chain still shows: that the pool paid, the amount, the time, and the exit back to a wallet. What it hides: which deposit, so which wallet, paid.

## Origin

The Base implementation is a Privacy Pools fork with an x402 facilitator.
This design adapts that architecture to Cardano's ledger limits.
It replaces the earlier private notes.

## License

MIT. See [LICENSE](LICENSE).

Dependencies keep their own licenses.
The prover uses snarkjs, which is GPL-3.0.
Check that before you ship a product that bundles it.
