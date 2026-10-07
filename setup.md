# Connect an existing agent to zx402

Give this guide to your coding agent in the project you want to connect.
Its task is to add private x402 payments to that agent using an existing zx402 pool.

```sh
curl -fsSL https://raw.githubusercontent.com/Marcussy34/zx402/main/setup.md
```

This command displays instructions. It does not install software or connect an agent by itself.

## Current availability

This is a developer integration on Cardano Preprod. Mainnet is not deployed.
The SDK, `@zx402/core`, is an unpublished source workspace package.
There is no public npm installer or hosted connection URL in this guide.
The existing pool's proving keys are not in the repository.
An integration needs the pool operator's connection details and matching proving files.

## 1. Inspect the project

Read the project's instructions and identify its agent framework, runtime, and payment entry point.
Ask about the runtime only if the project does not make it clear.
Preserve the existing agent and add a small payment adapter.

Use the source from [Marcussy34/zx402](https://github.com/Marcussy34/zx402).
Record the source revision used by the integration.
Read these maintained references before editing:

- [SDK guide](https://docs.zx402.org/guide/sdk-and-x402/): configuration, payment flow, and limits.
- [SDK options and methods](https://github.com/Marcussy34/zx402/blob/main/packages/sdk/src/sdk.ts): `createZx402` and `Zx402Options`.
- [x402 signer](https://github.com/Marcussy34/zx402/blob/main/packages/sdk/src/x402.ts): network, asset, price, and funding checks.
- [Working demo](https://github.com/Marcussy34/zx402/blob/main/ops/src/demo.ts): integration wiring. Read it as a reference; running it deposits and pays.

The source workspace requires Node.js 22.12 or later and installs its locked dependencies with `npm ci` at the repository root.
Use a separate source checkout or the existing checkout without overwriting user files.
Resolve the SDK and its workspace dependencies through that workspace. Do not suggest `npm install @zx402/core`.
If the user's agent runs elsewhere, explain and implement the local Node adapter it needs before claiming support.

## 2. Collect the connection inputs

Find these in the user's local configuration, or request the missing items from the pool operator:

| Input | Required check |
| --- | --- |
| Pool deployment record | Verify the intended pool ID, scripts, verification keys, and `preprod` network. |
| Indexer and relayer URLs | Use reachable services for that same pool. Example localhost URLs are not public endpoints. |
| Chain provider | Configure access to Preprod on the user's machine. Keep credentials out of chat and source control. |
| Pool asset | Read the exact policy and asset name from the deployment. Do not substitute another token with the same ticker. |
| Spend and ragequit artifacts | Obtain the WASM, proving keys, verification keys, and manifest that match this deployment. |
| Payment limits | Agree on a seller price cap and a total relayer fee cap, both in pool asset base units. |

Use the hash checks in [loadArtifacts](https://github.com/Marcussy34/zx402/blob/main/packages/prover/src/index.ts).
Follow [deploymentArtifacts](https://github.com/Marcussy34/zx402/blob/main/ops/src/node.ts) for matching verification keys to the deployment.
Do not treat a manifest hash check alone as proof that the files belong to the chosen pool.

If an input is unavailable, list the exact missing item and continue only with work that does not need it.
Do not invent endpoints, download locations, credentials, or a ready status.
Do not deploy a new pool, run a key setup, or replace `circuits/build/keys-<network>` to get past a missing artifact.

## 3. Add the payment adapter

Implement the following in the agent's local runtime:

1. Load a stable 32-byte agent seed from a private local configuration. Keep it separate from the funding wallet key. Never print either key or ask for it in chat.
2. Create a persistent `fileStore` from `@zx402/core`. Use a separate store path per agent and pool, create its parent directory, and preserve it across restarts. Back up the seed and store. The seed alone cannot recover unspent change notes.
3. Build the chain context as `{ provider, deployment }`. Construct `IndexerClient` and `RelayerClient` from `@zx402/api` with the supplied URLs.
4. Call `createZx402` with `seed`, `ctx`, `indexer`, `relayer`, `artifacts: { spend, ragequit }`, `store`, and an explicit `maxRelayerFee`.
5. Create `sdk.x402Signer({ mode: 'stealth', maxPrice })`. Use it with `ExactCardanoScheme` from `@x402/cardano/exact/client` and `wrapFetchWithPaymentFromConfig` from `@x402/fetch`, as the demo does.
6. Register only `cardano:preprod`. Set `spendControls.allowedAssets` to the deployment's exact wire asset from `assetWireUnit`, with an explicit `maxAmountPerPayment`. Use agreed limits, not whatever amount a seller happens to request.
7. Expose the paid request through the agent's existing tool or request interface. Keep proving local. Send only proof and payment intent to the relayer, never note secrets.

Keep the funding wallet and its refund key available for exits.
Preserve change notes, pending records, and one-time key counters in the store.
Do not retry a paid request automatically after an unclear result: the current SDK has no request-level payment deduplication.

## 4. Verify before funding

Run the adapter's type checks and local tests without submitting transactions.
Cover rejection of the wrong network, wrong asset, and a price above the configured cap.
Check that a restart loads the same note store and counters.

With verified connection inputs, call `sdk.sync()` to check indexer state against the chain.
Inspect a seller's 402 challenge using ordinary unpaid `fetch` and compare its network, asset, and price with the configured limits.
Do not invoke the payment-enabled fetch or `buildAndSignPaymentTransaction` as a dry run. The signer can move funds to a one-time address before returning.

Report the files changed, checks passed, and remaining blockers.
Distinguish a prepared adapter from a verified connection and a completed payment.
Do not report a payment as tested unless an approved test actually confirmed.

## 5. Let the user choose a test payment

CAUTION: deposits and payments submit transactions and cannot be undone. Get the user's approval for the test amount and fees before either action.

Use a separate Preprod wallet with the pool's exact test asset and test ADA for fees.
Explain the deposit, wait for an approved spendable note, then make only the agreed test request.
Confirm both payment legs and preserve the resulting change note.
Do not use mainnet or real funds for this setup.

Operating a pool is a separate task. See the [operator guide](https://docs.zx402.org/guide/running/) only when the user asks to run infrastructure.
