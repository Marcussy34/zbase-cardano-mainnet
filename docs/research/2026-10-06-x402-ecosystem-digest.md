# Research digest: x402, Masumi, stablecoins, and privacy prior art on Cardano

| Field | Value |
|---|---|
| Date | 2026-10-06 |
| Method | A research agent read npm metadata, cloned repos, and live pages. On-chain facts were confirmed through the public Koios API. |
| Status | Reference material. The Spec is the source of truth. |

"Unverified" marks a fact with no confirming source.

## 1. x402 on Cardano

### Package

- `@x402/cardano` 2.28.0, published 2026-09-29. Earlier: 2.26.0 (2026-09-18) and 2.27.0 (2026-09-22). License Apache-2.0.
- Repo: `github.com/x402-foundation/x402`. The Coinbase repo is now a fork of it.
- Dependencies: `@evolution-sdk/evolution` ^0.5.9, `@x402/core` ~2.28.0, `@noble/hashes`, `lz-string`.
- Only the TypeScript SDK supports Cardano.
- Networks: `cardano:mainnet`, `cardano:preprod`, `cardano:preview`.
- Assets: `lovelace` or `policyId.assetNameHex`. Defaults: USDM on mainnet, tUSDM on preprod.

### Flow (`specs/schemes/exact/scheme_exact_cardano.md`)

- The client signs a complete transaction and does not broadcast it. The facilitator submits it at settle time.
- The client sends the `PAYMENT-SIGNATURE` header. Its payload holds `transaction` (base64) and `nonce` (a UTXO reference that the transaction spends).
- `/verify` checks network, recipient, amount, asset, nonce, value conservation, minimum fee, expiry, and minimum ADA.
- `/settle` broadcasts, then waits for the confirmation policy. The default is 1 confirmation. After 75 seconds it returns `settlement_pending`, and the server retries once.
- The client pays the network fee. The facilitator needs no funded wallet.
- Fee sponsorship is not supported in this scheme version.
- A token payment carries roughly 1.2 to 1.5 ADA of minimum ADA with it.
- Three transfer methods: `default`, `masumi`, `script`. They describe where funds go, not where they come from.
- The client interface is pluggable: `ClientCardanoSigner.buildAndSignPaymentTransaction` returns `{ transaction, nonce }`.

### Script-funded payments

| Facilitator | Behavior | Source |
|---|---|---|
| TypeScript reference | Does not check input credentials. Rejects only when key and script witness counts are both zero. Rejects mint, withdrawals, and certificates without a full validator hook. | `exact/facilitator/scheme.ts` lines 756 and 1105 to 1112 |
| TypeScript reference, stated intent | An interface comment says the hook is the only way to accept script-controlled funding inputs. No code enforces that part. | `src/signer.ts` lines 356 to 362 |
| Cardano Foundation Java | Rejects script-funded inputs, collateral inputs, and reference inputs by default. Accepts them only with a `Phase1Validator` installed. | `cardano-foundation/cardano-x402-facilitator`, `docs/verification.md` lines 41 to 44 and 119 to 120 |

- Open issue 3673: the TypeScript facilitator re-encodes the signed transaction before it submits. A fix is open as pull request 3674.
- The `masumi` method cannot be script-funded. The buyer must be a key address that controls the nonce input.
- A plain transaction (inputs, outputs, fee, expiry) passes both facilitators by their documented rules.

### Other packages

| Package | Version | Note |
|---|---|---|
| `@odatano/x402` | 0.6.0 | x402 for SAP CAP services |
| `subbit-x402` | 0.2.3 | x402 batch settlement over payment channels. Research spike, preprod only |
| `ada-agent-wallet` | 0.2.8 | Policy-gated agent wallet with an x402 tool |
| `@cardano402/mcp-server` | 0.1.2 | MCP server for paid endpoints. Hosted facilitator advertises `cardano:mainnet` |
| Cardano Foundation Java facilitator | no release | Targets `@x402/cardano` 2.26.0 |

The Subbit README states: every output must hold about 0.98 ADA, about $0.23 in September 2026. It also states that 95% of the resources in the x402 discovery index sold for less than $0.27.

## 2. Masumi

- The escrow is `vested_pay`, written in Aiken for Plutus V3. Version 2 uses compiler 1.1.23.
- Version 2 parameters: `required_admins_multi_sig`, `admin_vks`, `cooldown_period`.
- The datum has 19 fields: `buyer`, `buyer_return_address`, `seller`, `seller_return_address`, `reference_key`, `reference_signature`, `seller_nonce`, `buyer_nonce`, `agent_identifier`, `collateral_return_lovelace`, `input_hash`, `result_hash`, `pay_by_time`, `submit_result_time`, `unlock_time`, `external_dispute_unlock_time`, `seller_cooldown_time`, `buyer_cooldown_time`, `state`.
- States: `FundsLocked`, `ResultSubmitted`, `RefundRequested`, `Disputed`, `WithdrawAuthorized`, `RefundAuthorized`.
- A lock with a script address as buyer or seller is permanently unspendable.
- Refunds: the buyer can withdraw after `submit_result_time` when no result exists, or request a refund before `unlock_time`.
- Disputes: admins settle after `external_dispute_unlock_time` with weighted signatures.
- Version 2 addresses: mainnet `addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d`, preprod `addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g`.
- The payment service builds transactions with Mesh and Blockfrost.
- Masumi's own x402 rail is for EVM chains only.
- The `masumi` method in `@x402/cardano` locks into the same escrow. A lock made by that package cannot be driven through a Masumi payment service node, because the seller signature payload differs.
- Tokens: Masumi names USDCx on mainnet and its own tUSDM on preprod. One Masumi guide still names USDM for mainnet.
- An audit that covers version 2 is unverified.

## 3. Stablecoins

Policy IDs come from the Cardano token registry and were confirmed on-chain through Koios.

Mainnet:

| Token | Policy ID | Asset name (hex) | Note |
|---|---|---|---|
| USDM | `c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad` | `0014df105553444d` | About 13.57M supply. x402 default |
| USDCx | `1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34` | `5553444378` | About 45.76M supply. Created 2026-02-18. Masumi mainnet token |
| USDA | `fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456` | `55534441` | About 4.23M supply |
| iUSD | `f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880` | `69555344` | About 1.44M supply |
| DJED | `8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61` | `446a65644d6963726f555344` | Minted once, so supply is not circulation |

All use 6 decimals.

Preprod has two different tUSDM tokens:

| Used by | Policy ID | Faucet |
|---|---|---|
| `@x402/cardano` | `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9` | `tusdm.moneta.global` |
| Masumi | `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde` | `dispenser.masumi.network` |

Both use asset name `0014df10745553444d`. They are not interchangeable.

## 4. Privacy prior art on Cardano L1

| Project | What it is | Status |
|---|---|---|
| Lovejoin (`logical-mechanism/Lovejoin`) | Mixer for fixed-size ADA boxes with sigma proofs. No Merkle tree, no nullifier set, no operator | Mainnet since 2026-09-26. Unaudited |
| Seedelf (`logical-mechanism/Seedelf-Wallet`) | Stealth wallet with Schnorr proofs. Values are not hidden or mixed | Mainnet. Release 0.5.0 on 2026-10-05 |
| Encoins v1 (`encryptedcoins`) | Bulletproofs-based protocol | Last code push 2024-08. Status in 2026 unverified |
| Encoins v2 on the zkFold UTxO accumulator | Fixed-value pools with Plonkup proofs. The pool value is a full `Value`, so tokens are possible | Preprod only. Mainnet deployment unverified |
| TrustLevel ZK lending (`TrustLevel/ZK-Defi-Protocol`) | Groth16 in Aiken with Poseidon commitments and nullifiers | Live on preprod |
| Pulse (`pulse-finance/circuits`) | Private notes in a depth 32 tree, Poseidon255, Groth16 | Circuits only. Deployment unverified |
| Cardano Semaphore (`Modulo-P/Cardano-Semaphore`) | Port of Semaphore | Alpha |

- No Privacy Pools style protocol was found on Cardano L1.
- No live shielded pool with hidden amounts or stablecoin support was found.
- Lovejoin patterns worth knowing: collateral comes from a shared provider (`giveme.my`), and mixes need no submitter signature. Lovejoin registers a stake credential, so its transactions carry withdrawals.

## 5. Midnight

- Midnight mainnet is live since March 2026. Its blog of 2026-09-28 says permissionless contract deployment is live. A news article of 2026-10-01 still calls that imminent.
- x402 has no Midnight mechanism.
- Transfers from Cardano to Midnight exist only through third-party messaging. A trustless bridge is still a design study.
- Inference: no existing tooling settles a Cardano L1 x402 payment privately through Midnight.

## 6. TypeScript tooling

Versions from `npm view` on 2026-10-06.

| Library | Version | Plutus V3, reference scripts, inline datums | Used by |
|---|---|---|---|
| Mesh (`@meshsdk/core`) | 1.9.1 | Yes | Masumi, Lovejoin, TrustLevel |
| Evolution SDK (`@evolution-sdk/evolution`) | 0.5.17 | Yes | `@x402/cardano`, subbit-x402 |
| Lucid Evolution (`@lucid-evolution/lucid`) | 0.6.7 | Yes. Ships an emulator provider | none of the above |
| Blaze (`@blaze-cardano/sdk`) | 0.3.1 | Yes | none of the above |

Providers:

- Blockfrost: free plan with 50,000 requests a day and one project. Whether that plan includes mainnet is unverified.
- Koios: 5,000 requests a day without a key, 50,000 with a free registration.
- Demeter: hosted Ogmios, Kupo, and Blockfrost-style APIs, with free access for open-source and early teams.
- The x402 reference facilitator needs Blockfrost for confirmation depth above 0.

## 7. Not found

- A hosted Cardano x402 facilitator that documents support for script-funded payments.
- Any x402 implementation for Midnight.
- A Hydra-based privacy product.
- Maestro pricing and free tier.
- An audit that covers the Masumi version 2 contract.
