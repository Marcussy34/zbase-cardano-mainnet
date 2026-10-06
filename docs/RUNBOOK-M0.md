# zBase Cardano: M0 Mainnet Canary Runbook

| Field | Value |
|---|---|
| Status | v1.0, 2026-10-06 |
| Goal | Prove every flow on mainnet with capped team funds |
| Companions | [SPEC.md](./SPEC.md), [CEREMONY.md](./CEREMONY.md), [TEST-PLAN.md](./TEST-PLAN.md), [measurements.md](./measurements.md) |

Each step has a test ID from the test plan (`E2E-01` to `E2E-17`) and a pass check.

[RUNBOOK-PREPROD.md](./RUNBOOK-PREPROD.md) holds the exact commands. They are the same on mainnet with `NETWORK=mainnet`.
Steps 4 to 10 and step 13 of this runbook ran on Preprod on 2026-10-06. [measurements.md](./measurements.md) lists the transactions.
A Ragequit (step 12) and a pause with its unpause (step 14) also confirmed there. Their pass checks, an unapproved label and an Insert during a pause, ran only on the local test chain.
Not run on a live network yet: a second payment from a change note (step 11), the negative suite (step 15) and the 7 day canary (step 17). The local test chain covers steps 11 and 15 with the real validators.
Do the steps in order. Stop at the first step that fails its check.

CAUTION: mainnet funds are real, and deployed scripts cannot be changed. Keep the M0 caps: 50 ADA per deposit and 500 ADA in the pool.

CAUTION: evaluate every transaction through the provider before you submit it. A failing script transaction that reaches a block costs the collateral.

CAUTION: never put a seed phrase, a signing key, or a proving key in this repo.

## 1. Before you start

Every test in [TEST-PLAN.md](./TEST-PLAN.md) sections 3 to 11 passes in CI.

Wallets and keys:

| Name | Purpose | Funds |
|---|---|---|
| Operator wallet | Publishes reference scripts and runs Init | 300 ADA |
| Relayer wallet | Pays fee inputs and holds one collateral UTXO | 20 ADA, with one UTXO of exactly 5 ADA |
| Admin keys | Sign config updates | Three keys, threshold two |
| ASP keys | Sign ASP root updates | Two keys, threshold one for M0 |
| Test wallets A, B, C | Make test deposits | 15 ADA each |
| Test seller wallet | Receives the x402 payment | Any |

Services running: indexer, crank, relayer, ASP tool, solvency monitor.
A test seller runs the stock `@x402/cardano` server with its TypeScript facilitator.

## 2. Phase A: prepare

1. **E2E-01. Freeze the circuits.** Tag the commit. Pass check: a clean rebuild gives the same `r1cs` hashes twice.
2. **E2E-02. Run the ceremony.** Follow [CEREMONY.md](./CEREMONY.md) for all three circuits. Pass check: `snarkjs zkey verify` reports OK for each key, and the manifest is committed.
3. **E2E-03. Build the validators.** Apply the three verification keys as parameters. Pass check: the script hashes are in the manifest, and `aiken check` passes against the ceremony keys.

## 3. Phase B: deploy

4. **E2E-04. Fund the operator wallet.** Pass check: the wallet holds at least 300 ADA.
5. **E2E-05. Publish the reference scripts.** Pass check: each reference UTXO exists, and its script hash equals the manifest.
   About 50 to 80 ADA stays in these UTXOs until the operator spends them. That number is an estimate.
6. **E2E-06. Submit Init.** Pass check: the pool, config, and ASP UTXOs exist with the genesis datums. The pool holds 6 ADA and the pool NFT.
   CAUTION: Init spends the seed UTXO once. A wrong datum here means a new deployment and new script hashes.

## 4. Phase C: functional run

7. **E2E-07. Deposit 10 ADA from wallet A.** Use the SDK. Pass check: a UTXO sits at the deposit address with the inline `DepositDatum`.
8. **E2E-08. Run Insert.** Pass check: the pool size is 1, and the root changed. The credited value is 9.7 ADA. The on-chain label equals the label the SDK computed.
9. **E2E-09. Approve the label.** Run the ASP update. Pass check: the SDK shows the note as `spendable`.
10. **E2E-10. Pay the test seller 3 ADA in stealth mode.** Pass check: the seller returns HTTP 200 and a transaction hash. On-chain, the pool paid a one-time key, and that key paid the seller. Wallet A appears in neither transaction.
    Repeat this step against the Cardano Foundation Java facilitator if one is available. Record the result as item 8 of SPEC section 17.
11. **E2E-11. Pay again from the change note.** Wait for the Insert that adds the change note. Pass check: the second payment confirms, and the SDK balance equals 9.7 ADA minus both withdrawn amounts.
12. **E2E-12. Ragequit.** Deposit 10 ADA from wallet B and run Insert. Do not approve the label. Run ragequit. Pass check: a private settle is refused, the ragequit confirms, and wallet B receives the credited value minus network fees.
13. **E2E-13. Refund.** Deposit 5 ADA from wallet C. Refund it before Insert. Pass check: wallet C gets the deposit back, and the crank ignores it.
14. **E2E-14. Pause deposits.** The admins set `deposits_paused`. Pass check: an Insert that absorbs a deposit fails in evaluation, and a settle still confirms. Then unpause.

## 5. Phase D: negative suite

15. **E2E-15. Run the negative suite in evaluation only.** Build each transaction below and evaluate it. Pass check: every one fails evaluation. Never submit them.

| Case | Expected failing rule |
|---|---|
| A settle with one byte of the proof changed | S7 |
| A settle that reuses a spent nullifier hash | S8 |
| A settle whose payout address differs from the intent | S10 |
| A settle that removes more than `withdrawn` from the pool | S12 |
| A settle against a root older than the history | S2 |
| A settle with `nullifier_hash + r` as input | S4 |
| A settle that also spends a deposit UTXO | S1 |
| An Insert with a wrong new root | I9 |
| A ragequit without the refund key signature | R3 |

## 6. Phase E: record and watch

16. **E2E-16. Record the measurements.** Fill [measurements.md](./measurements.md) for every transaction type. Update the estimates in SPEC section 10 where they differ by more than 20%.
17. **E2E-17. Run the canary for 7 days.** Make one deposit and one stealth payment each day. Pass check: the solvency monitor reports no gap for 7 days.

## 7. If something goes wrong

- **A step fails its check:** stop. Do not continue with later steps. Write down the transaction hash and the evaluation error.
- **You suspect a bug that puts funds at risk:** pause deposits, then exit every note with settle or ragequit. Exits cannot be paused.
- **A fix is needed in a circuit or a validator:** it means a new ceremony, new script hashes, and a new pool. The old pool stays usable for exits.

## 8. Winding down a canary pool

1. Pause deposits.
2. Exit every note with settle or ragequit.
3. Collect accrued fees, if any.
4. Spend the reference script UTXOs back to the operator wallet.

The 6 ADA pool reserve and the minimum ADA in the config and ASP UTXOs stay locked for good. That is the cost of one deployment.
