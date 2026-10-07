# Stock Cardano x402 demo

This example runs a local HTTP seller and the stock Cardano facilitator in one process.
The plain buyer signs with one raw 32-byte Ed25519 seed.
It has no privacy layer. The facilitator submits the signed transaction.

Use the dependencies already installed at the repository root, and run the commands below from there.
The example is a workspace package and imports `@zx402/txlib` by name.

## Preprod settings

Use two terminals with these environment variables already supplied by your secret manager or terminal environment.
Neither script loads an environment file.
Do not paste a seed or provider credential into source, shell history, logs, or a report.

| Variable | Used by | Value |
| :--- | :--- | :--- |
| `NETWORK` | Both | `preprod`, the default. `mainnet` is also accepted. |
| `BLOCKFROST_PROJECT_ID` | Both | A project ID for the selected network. |
| `SELLER_ADDRESS` | Seller | The seller's Preprod bech32 payment address. |
| `SELLER_PORT` | Seller | Optional. Defaults to `4021`. |
| `SELLER_PRICE_ASSET` | Seller | Optional. Defaults to `lovelace`. Tokens use a lowercase hex `policy.name` unit. |
| `SELLER_PRICE_AMOUNT` | Seller | Optional. Defaults to `2000000` base units of the selected asset. |
| `SELLER_PRICE_LOVELACE` | Seller | Legacy amount alias for `lovelace` only, used when `SELLER_PRICE_AMOUNT` is absent. |
| `SELLER_URL` | Buyer | Optional. Defaults to `http://localhost:4021`. |
| `BUYER_SEED_HEX` | Buyer | Exactly 64 hex characters representing a raw Ed25519 seed, not a mnemonic or extended key. |
| `BUYER_MAX_LOVELACE` | Buyer | Optional payment cap. Defaults to `2000000`. Raise it only for an intended higher quote. |

Fund the buyer's enterprise address on Preprod with test ADA for the quoted price, transaction fee, and change.
Derive that address with `enterpriseAddress(seed, 'preprod')` from `packages/txlib/src/keys.ts`.
`keySigner(...).getAddress()` returns the same address.
The seller and facilitator require no signing key or funds.

1. In the seller terminal, start the server.

   ```sh
   node --import tsx examples/x402-seller/src/seller.ts
   ```

2. In the buyer terminal, check the unpaid response.

   ```sh
   curl -i http://localhost:4021/weather
   ```

   Expect HTTP 402 and a `PAYMENT-REQUIRED` header.
   `/health` returns HTTP 200 without payment.

CAUTION: The next command authorizes the quoted payment up to `BUYER_MAX_LOVELACE` and pays a network fee.
The facilitator broadcasts it. On mainnet, this spends real ADA and cannot be undone.

3. In the buyer terminal, pay for the weather.

   ```sh
   node --import tsx examples/x402-seller/src/pay-plain.ts
   ```

   Expect status `200`, `{"weather":"sunny","temperatureC":28}`, and the settlement transaction hash.

4. In the seller terminal, press Ctrl+C to stop the server.

## Token pool seller

The seller can quote any pool asset. Use these settings for 2 tUSDM on Preprod, which has 6 decimals:

```sh
export SELLER_PRICE_ASSET=16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d
export SELLER_PRICE_AMOUNT=2000000
```

Start the seller with the same command above, then use the pool demo with a deployment holding that asset.
The demo deposits and pays in the deployment's asset, and the relayer funds the payment's ADA requirement.
The plain buyer remains an ADA example and only accepts `lovelace` quotes.

## Protocol and limits

The server uses `x402ResourceServer`, `x402HTTPResourceServer`, `x402Facilitator`, and the stock Cardano exact schemes.
Its chain signer uses Evolution SDK with Blockfrost at `https://cardano-preprod.blockfrost.io/api/v0` on Preprod.
On mainnet, it uses `https://cardano-mainnet.blockfrost.io/api/v0`.
The reference signer evaluates the transaction during verification, before submission.

The stock fetch client handles the 402 retry and `PAYMENT-SIGNATURE` encoding.
The raw-key signer returns signed CBOR as base64 and a consumed `txHashHex#index` nonce.
It uses live protocol parameters and a provider tip to set an expiry within the quoted timeout, which is 300 seconds.
The buyer never submits. The facilitator verifies, submits, and waits for settlement evidence.
HTTP 200 carries `PAYMENT-RESPONSE`, which includes the settlement transaction hash.

The default confirmation policy requires block inclusion plus one newer canonical block.
The stock facilitator waits up to 75 seconds per settlement call.
The resource server retries a pending settlement once with the same payload.
A slow chain may still return a pending response after broadcast. Check the transaction before starting another payment.

The signer supports lovelace and ordinary address payments only.
It rejects another network, an unsupported asset transfer method, and a price below minimum ADA.
It returns change to the buyer, including native tokens in selected inputs.
It skips UTXOs with reference scripts.
The buyer explicitly allows lovelace because the stock client defaults to USD stablecoins.

The server binds to loopback. This example provides synthetic weather and has no persistent purchase records.
The stock settlement guard prevents duplicate broadcasts within one process, but does not bind default payments to individual HTTP requests.
Do not use this example as a production access-control system.
Live Preprod acceptance remains a lead-run check. The offline tests do not prove live Blockfrost availability or confirmation timing.

## Offline checks

1. Run the tests.

   ```sh
   node --import tsx --test examples/x402-seller/test/seller.test.ts
   ```

2. Run TypeScript checking.

   ```sh
   npx tsc --noEmit -p examples/x402-seller
   ```

Tests inject `SellerOptions.facilitatorSigner` with an in-memory chain adapter.
The stock client, server, verifier, and settlement logic remain real.
Only local HTTP requests run. No Cardano provider or network is contacted.
