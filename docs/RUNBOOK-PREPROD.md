# zBase Cardano: Preprod Runbook

| Field | Value |
|---|---|
| Status | v1.0, 2026-10-06 |
| Goal | Run the whole product on the Preprod test network |
| Companions | [RUNBOOK-M0.md](./RUNBOOK-M0.md), [measurements.md](./measurements.md), [SETUP.md](./SETUP.md) |

Every step below ran on Preprod on 2026-10-06 with the code of this repository.
The transaction hashes of that run are in [measurements.md](./measurements.md), section 3.
The mainnet canary in [RUNBOOK-M0.md](./RUNBOOK-M0.md) uses the same commands with `NETWORK=mainnet`.

## 1. What you need

- Node.js 22 or newer.
- A Blockfrost project for Preprod. The free plan is enough. Section 8 explains the quota.
- A new 32-byte key for the operator. `openssl rand -hex 32` makes one.
- About 300 test ADA from the Preprod faucet for that key. Step 3 of section 3 shows its address.

CAUTION: use a new key. Never put the key of a real wallet into this project.

## 2. Build once

1. Install the tools: `npm ci`
2. Compile the circuits: `npm run build:circuits`
3. Make the development keys: `npm run setup:dev`

Step 3 takes about 30 minutes the first time. It also makes the phase 1 file that the network key setup reuses.

## 3. Deploy a pool

1. Copy `.env.example` to `.env`.
2. Set `NETWORK=preprod`, `BLOCKFROST_PROJECT_ID`, and `OPERATOR_SEED_HEX` in `.env`.
3. Print the addresses and the cost: `npm run ops:deploy -- --dry-run`
4. Send test ADA from the faucet to the `operator` address that step 3 printed.
5. Make the proving keys for this network: `npm run ops:setup`
6. Deploy: `npm run ops:deploy`

CAUTION: `.env` holds a signing key. Git ignores the file. Never commit it and never paste it anywhere.

CAUTION: step 5 is a key setup by one party. Whoever runs it could forge proofs by keeping its randomness. That is acceptable on a test network, and on mainnet only for capped funds of the team itself.

Step 5 takes about 4 minutes. It writes the proving keys to `circuits/build/keys-preprod/` and the verification keys to `deployments/preprod/keys/`.

CAUTION: back up the folder with the proving keys before step 6. Git ignores it, and no setup run can make the same keys again.
Without the proving keys of a pool, nobody can insert, pay or exit, and the notes in that pool stay locked.
A deposit that is not inserted yet can still be refunded, because a refund needs no proof.

Step 5 never replaces a complete set of keys. If the folder already holds the three key files, the command keeps them and says so.
To make keys for another pool, move the folder away first. Keep it for as long as the old pool holds funds.
Step 6 submits four transactions and takes about 3.5 minutes. It writes the record `deployments/preprod.json`.
A deployment costs about 245 test ADA. Of that, 160 goes to the role keys of the crank, the relayer, the association service and the test user, and 73.6 stays in the four reference script outputs.

If `deployments/preprod.json` already exists, step 6 stops. This repository holds the record of the pool from 2026-10-06.
To use that pool you need its proving keys, which are not in the repository. To deploy your own pool, add `-- --force` to step 6.

## 4. Run the node

1. Start the node: `npm run node -w ops`

The node runs the indexer, the crank, the association service and the relayer in one process.
It serves the indexer on `http://127.0.0.1:4010` and the relayer on `http://127.0.0.1:4011`.
It logs one line for each round that did something, for example an Insert or an association update.
A line such as `indexer: Chain tip changed during sync` is normal. The next round succeeds.
Stop the node with Ctrl+C.

The node reads four optional settings from the environment:

- `ZBASE_INTERVAL_MS` is the pause between two rounds in milliseconds. The default is 10000.
- `ZBASE_IDLE_RETRY_MS` is the time before the crank or the association service repeats a step that submitted nothing, while its input data is unchanged. The default is 20000.
- `ZBASE_INDEXER_PORT` is the port of the indexer. The default is 4010.
- `ZBASE_RELAYER_PORT` is the port of the relayer. The default is 4011.

## 5. Run a seller

1. Start the example seller in a second terminal: `SELLER_ADDRESS=<address> npm run seller -w examples/x402-seller`

Use the `seller` address that step 3 of section 3 printed, or any Preprod address you own.
The seller is the stock x402 server with its stock facilitator. It knows nothing about the pool.
It sells `GET /weather` for 2 ADA on `http://127.0.0.1:4021`.

## 6. Play the story

1. Run the demo in a third terminal: `npm run demo -w ops`

The demo does this, and prints each transaction:

1. It deposits 10 test ADA from the `user` role key.
2. It waits until the crank inserted the deposit and the association service approved it.
3. It asks the seller for the weather, gets HTTP 402, and pays through the stock x402 client with the SDK's stealth signer. The pool pays a new one-time address, and that address pays the seller.
4. It prints the weather.
5. It exits the rest of the note in public, back to the `user` key.

One run took 3.5 minutes on Preprod with the final code. Slow blocks can double that.
The user ends with about 5 ADA less: 2 ADA for the weather, 1 ADA for the relayer, 0.3 ADA for the crank, and the network fees.
You can run the demo again at any time. It keeps its notes in `deployments/preprod/demo-store.json`.
Keep that file and back it up. Without it the demo still works, because the SDK finds its old deposits on chain and takes new secrets. But a change note that was still in the pool is then out of reach.
If you changed a port, set `INDEXER_URL`, `RELAYER_URL` or `SELLER_URL` for the demo.

## 7. Admin actions

- Pool status and every role address with its balance: `npm run admin -w ops -- status`
- Pause deposits: `npm run admin -w ops -- pause`
- Allow deposits again: `npm run admin -w ops -- unpause`
- Collect accrued fees for the treasury: `npm run admin -w ops -- collect-fees`
- Wind a pool down: `npm run admin -w ops -- sweep-references --yes`

CAUTION: `sweep-references` spends the reference script outputs of the pool back to the operator. After it, nobody can use the pool. Pause deposits and exit every note first.

Exits cannot be paused. A paused pool still serves private payments and Ragequit.

## 8. Provider quota

Every read of the chain is a request to Blockfrost. The free plan allows 50,000 requests a day.

These numbers were measured on the Preprod pool of this repository, which had about 20 transactions.

- A round of the node that finds no new block makes 1 request.
- A round after a new block makes 8 requests.
- For two minutes after a change, the node reads each new block a second time. That adds 7 requests per block.
- A node that submits nothing uses about 1,100 to 1,600 requests an hour.
- A start of the node replays the pool history once. That took 33 requests for 17 pool transactions.
- One demo run adds about 150 to 200 requests in the node.

So an idle node needs about 27,000 to 39,000 requests a day. That fits the free plan and leaves room for some dozens of demo runs.
No run of a whole day has confirmed this yet.
The demo and the seller's facilitator use the same Blockfrost project and make their own requests. These numbers do not include them.
A read of the history costs one more request for every 100 transactions at the pool address and at the deposit address.
To spend fewer requests, set a longer round with `ZBASE_INTERVAL_MS`. Payments then take longer.
For a busy pool, use a paid plan or your own chain backend.

## 9. If something goes wrong

- **The deploy stops midway:** nothing is lost. The role keys and the reference script outputs belong to keys derived from your operator seed. Fix the cause, then run step 6 of section 3 again with `-- --force`.
- **The demo stops after the pool paid the one-time address:** the error names the index of the one-time key. The funds sit at that key's address until you move them. The SDK method `recoverOneTimeFunds({ index, payTo })` sends them to an address of your choice.
- **The node logs `Pool history has not reached the current pool UTXO`:** the provider's history is a moment behind its UTXO view. The next round succeeds.
- **A payment waits for minutes:** Preprod sometimes makes no block for a minute or more. The services wait for confirmed data before each step.
