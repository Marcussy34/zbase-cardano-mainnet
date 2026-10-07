# zx402: Product Requirements (PRD)

| Field | Value |
|---|---|
| Status | Approved v1.0. The owner approved it on 2026-10-06 |
| Date | 2026-10-06 |
| Owner | Marcus |
| Companions | [SPEC.md](./SPEC.md), [PLAN-M0.md](./PLAN-M0.md), [HANDOFF.md](./HANDOFF.md) |
| Target network | Cardano mainnet, protocol version 11 |

## 1. Summary

zx402 lets an AI agent pay on Cardano without showing which wallet paid.
The agent deposits into a shared pool once.
Later it pays sellers, escrows, or payment channels from the pool with a zero-knowledge proof.
The chain shows the pool as the payer.
A compliance list blocks flagged deposits from private use.

The product adapts the zBase architecture that runs on Base.
The cryptography is the same family.
The on-chain design is new, because Cardano has different limits.

## 2. Problem

Every x402 payment and every Masumi escrow on Cardano is public.
Anyone can read the paying wallet, the seller, the amount, and the time.

- A competitor can map an agent's suppliers, spend, and query rate.
- An enterprise cannot run buying agents if its books are public.
- No Cardano privacy tool solves this for agents today (see section 15).

## 3. Goals and non-goals

### Goals

| ID | Goal |
|---|---|
| G1 | Break the on-chain link between an agent's funding wallet and its payments. |
| G2 | Work with stock x402 sellers and with Masumi escrow. Sellers change nothing. |
| G3 | Stay non-custodial. No operator can take or freeze user funds. Exits always work. |
| G4 | Be compliant by design: an approved-deposit list, plus a public exit for everyone else. |
| G5 | Run on mainnet from day one, with on-chain caps that bound any loss. |
| G6 | Make honest claims. Publish the anonymity set size, trust assumptions, and known leaks. |

### Non-goals

- Cent-sized payments settled one by one on L1. The ledger floor is about 1 ADA per output.
- Hiding amounts. Deposit and payment amounts stay public in v1.
- A general public mixer, or fixed-denomination mixing.
- Midnight or cross-chain delivery.
- A token, or yield on pooled funds.

## 4. Users and jobs

| User | Job to be done |
|---|---|
| Buyer agent developer | Pay sellers without exposing my treasury wallet or my supplier list. Integrate in under one hour. |
| Seller or API provider | Get paid as usual through x402. Change nothing. |
| Masumi agent operator | Fund job escrows without linking them to my main wallet. |
| Pool operator (us) | Run the relayer, the tree crank, the indexer, and the compliance list. Watch solvency. |
| Compliance reviewer | Get proof of one agent's own payment history when that agent's owner chooses to share it. |

## 5. Cardano facts that shape the product

These are verified facts. Sources are in SPEC Appendix A.

| Fact | Consequence for the product |
|---|---|
| Every output must hold about 0.98 ADA (4,310 lovelace per byte). | No payment under about 1 ADA. A USDM payment carries 1.2 to 1.5 ADA with it. |
| In September 2026, 95% of x402 resources cost under $0.27, and 0.98 ADA was about $0.23. | Typical x402 call prices sit below the floor. Per-call L1 settlement is the wrong unit. |
| One Groth16 check costs 2.0B to 2.7B of the 10B CPU limit per transaction. | One proof per transaction is affordable. Two proofs also fit. |
| One Poseidon hash on-chain costs about 1.27B CPU (measured). | The validator cannot hash the tree. A proof must cover each tree update. |
| A block holds 20B CPU and arrives about every 20 seconds. | At most about 5 private payments per block. A payment takes 20 to 60 seconds. |
| In x402 on Cardano the buyer hands over a signed transaction. The seller's facilitator submits it later. | We integrate as a client signer. A shared pool UTXO must not change during that gap. |
| Facilitators differ on script-funded payments. The reference TypeScript code accepts them. The Cardano Foundation Java facilitator rejects them by default. | The default path for stock sellers pays from a one-time key, not straight from the pool. |
| A stock x402 facilitator rejects transactions that mint or withdraw rewards. | Settle transactions use spend validators only. |
| Masumi names USDCx as its mainnet token. x402 on Cardano defaults to USDM. | Stablecoin pools should cover both. |

The product conclusion: zx402 is a **private funding rail**.
It fits payments of a few ADA or more.
It also fits funding an escrow, a payment channel, or a tab that then meters small calls off-chain.

## 6. Use cases

Listed in priority order.

| ID | Use case | Release |
|---|---|---|
| U1 | Deposit from any wallet with one ordinary transaction. | M0 |
| U2 | Pay any stock x402 seller privately, 1 ADA or more, through a one-time stealth address (two steps). | M0 |
| U3 | Exit publicly (ragequit) if the deposit is not approved, or if the user wants out. | M0 |
| U4 | Fund a Masumi escrow privately. | M1 |
| U5 | Pay straight from the pool in one transaction, through a zBase-aware facilitator. | M1 |
| U6 | Fund a payment channel or tab privately (x402 batch settlement, Tab402). | M1 |
| U7 | Export a disclosure receipt for an auditor. | M1 |
| U8 | Receive from a privacy-unaware payer straight into the pool. | M2 |

## 7. Functional requirements

Each requirement has an ID and a first release. The SPEC shows how each one is met.

### Deposits

| ID | Requirement | Release |
|---|---|---|
| FR-D1 | A user deposits by sending one ordinary transaction with an inline datum. No proof is needed at deposit. | M0 |
| FR-D2 | A depositor can refund a deposit at any time before the pool absorbs it. | M0 |
| FR-D3 | The chain enforces a minimum deposit, a maximum deposit, and a pool cap. | M0 |
| FR-D4 | Each deposit gets a unique label that the chain derives. | M0 |

### Tree maintenance

| ID | Requirement | Release |
|---|---|---|
| FR-T1 | Anyone can insert pending notes and deposits into the tree by posting a proof. | M0 |
| FR-T2 | The validator never trusts a root supplied by an operator. | M0 |

### Payments

| ID | Requirement | Release |
|---|---|---|
| FR-P1 | A note holder pays one payout per settle, with an optional inline datum. | M0 |
| FR-P2 | A note holder pays up to four payouts in one settle. | M1 |
| FR-P3 | The proof binds the payouts, the amounts, the expiry, and the pool. | M0 |
| FR-P4 | A partial spend creates a change note. | M0 |
| FR-P5 | No note can be spent twice. | M0 |
| FR-P6 | Anyone can submit a settle. A user can relay for themselves. | M0 |

### x402 and Masumi

| ID | Requirement | Release |
|---|---|---|
| FR-X1 | The SDK ships a stealth mode. It funds a one-time key from the pool, then pays with the stock `@x402/cardano` client signer. | M0 |
| FR-X2 | Settle transactions contain no mint, no reward withdrawal, and no certificate. | M0 |
| FR-X3 | A zBase facilitator mode builds the pool transaction at settle time (facilitator mode). | M1 |
| FR-X4 | A direct handoff signer returns the pool transaction itself. It is experimental, because some facilitators reject script-funded inputs. | M1 |
| FR-M1 | The stealth mode can lock a Masumi `vested_pay` escrow with the stock `masumi` method. | M1 |

### Compliance

| ID | Requirement | Release |
|---|---|---|
| FR-C1 | Every private settle proves the note's label is on the current approved list (ASP root). | M0 |
| FR-C2 | The original depositor can always exit publicly with a ragequit. | M0 |
| FR-C3 | The ASP operator can approve and remove labels. A removal takes effect with the next root. | M0 |
| FR-C4 | The SDK exports a disclosure receipt that links one deposit to its payments. | M1 |

### Fees

| ID | Requirement | Release |
|---|---|---|
| FR-F1 | The user fixes the total amount that leaves the pool. A relayer cannot take more. | M0 |
| FR-F2 | A protocol fee in basis points accrues inside the pool. The chain enforces a hard cap. | M0 (set to 0) |
| FR-F3 | Each deposit pays a flat crank fee to whoever inserts it. | M0 |

### Admin and safety

| ID | Requirement | Release |
|---|---|---|
| FR-A1 | The admin can pause new deposits. The admin cannot pause payments or exits. | M0 |
| FR-A2 | The admin can change caps and fees only inside hard bounds fixed in the script. | M0 |
| FR-A3 | No admin action can move or freeze user funds. | M0 |
| FR-A4 | A fix ships as a new pool version. Users exit the old pool at will. | M0 |

### SDK and operations

| ID | Requirement | Release |
|---|---|---|
| FR-S1 | The SDK proves on the agent's machine by default. Note secrets never leave it. | M0 |
| FR-S2 | A user can recover all notes from one seed plus chain data. | M0 |
| FR-S3 | The SDK syncs the tree without telling the server which notes it owns. | M0 |
| FR-S4 | The SDK is TypeScript for Node 22 or later. Its API mirrors `@zbase-protocol/core` where that makes sense. | M0 |
| FR-O1 | A solvency monitor checks pool balance against public deposits and payments. | M0 |
| FR-O2 | A public status page shows pool balance, anonymity set, and queue depth. | M1 |

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | The validator range-checks every public input and rejects non-canonical points. |
| NFR-2 | A multi-party setup ceremony runs before any outside funds enter. |
| NFR-3 | An external audit of circuits and validators happens before caps are lifted. |
| NFR-4 | Scripts are immutable. Verification keys are pinned as script parameters. |
| NFR-5 | The relayer keeps no logs that tie an IP address to a payment beyond abuse control. Retention is published. |
| NFR-6 | A settle uses at most 35% of transaction CPU and 15% of transaction memory. |
| NFR-7 | Proof generation for a payment takes at most 5 seconds on a 4-core machine. |
| NFR-8 | The median time from request to one confirmation is at most 60 seconds. |
| NFR-9 | The all-in network cost of one private payment is at most 1.2 ADA in stealth mode. M0 measures this. |
| NFR-10 | A user can exit with the operator offline, using the open-source prover. |

## 9. Release plan

| Release | Who | Scope | Caps | Exit criteria |
|---|---|---|---|---|
| M0 mainnet canary | Team funds only | ADA pool, deposit, insert, settle, stealth-mode x402 payment, ragequit | 50 ADA per deposit, 500 ADA pool | Every flow runs on mainnet. Costs are measured. Monitor is green for 7 days. |
| M1 guarded alpha | Invited users | Facilitator mode, direct handoff (experimental), Masumi funding, multi-payout, status page | 500 ADA per deposit, 25,000 ADA pool | Public setup ceremony done. 200 private settles. No invariant alert. |
| M2 public beta | Open | Stablecoin pools (USDM, USDCx), pricing on, payer-agnostic receive | Raised after audit | External audit closed. Legal review done. |
| M3 scale | Open | Nullifier sharding, larger batches, Poseidon builtin migration if it ships | To be set | To be set |

Estimate: M0 is one to two weeks of focused build. This is an estimate, not a commitment.

## 10. Success metrics

| Release | Metric | Target |
|---|---|---|
| M0 | Scripted mainnet flows that pass | 100% |
| M0 | Settle cost and budget | Inside NFR-6 and NFR-9 |
| M1 | Distinct depositors | 20 or more |
| M1 | Private settles | 200 or more |
| M1 | Settle success rate | 98% or more |
| M2 | Approved unspent deposits (anonymity set) | 100 or more |
| M2 | Integrated sellers or Masumi agents | 3 or more |

## 11. Pricing

- The relayer quotes a fee that covers network cost. Expect about 1.0 to 1.2 ADA per private x402 payment in stealth mode. This is an estimate until M0 measures it.
- The protocol fee is 0 in M0 and M1. zBase on Base charges 5% per settle. We decide before M2.
- The deposit fee is 0. Each deposit pays a 0.3 ADA crank fee.

A fee near 1 ADA is large against a 2 ADA payment and small against a 100 ADA escrow.
That is why the product targets funding flows, not per-call payments.

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Bug in a circuit or the verifier | Loss of all pooled funds | On-chain caps, canary with own funds, tests against every invariant, external audit |
| Setup ceremony compromise | Forged proofs | Multi-party phase 2, public transcript |
| Small anonymity set at launch | Weak privacy | Publish the metric, seed liquidity, guide users on timing and amounts |
| Regulatory action against pooled privacy | Service shutdown | ASP gate, public exit, no custody, legal review before M2 |
| Price floor mismatch | Low demand for per-call use | Position as a funding rail for escrows, channels, and tabs |
| One pool UTXO | Low throughput | Relayer chaining now, nullifier sharding later |
| Young dependencies | Breakage | Pin versions, own minimal verifier, own tests |
| Facilitators differ on script-funded inputs | A direct handoff can be rejected, or can go stale while the seller works | Stealth mode is the default. Direct handoff stays experimental |

## 13. Dependencies

- Cardano mainnet at protocol version 11 or later.
- `@x402/cardano` 2.28 or later.
- Aiken 1.1.24 or later.
- circom 2.2.x and snarkjs 0.7.x with BLS12-381.
- `poseidon-bls12381-circom` 1.0.0.
- `aiken-lang/merkle-patricia-forestry` 2.1.0.
- A BLS12-381 powers of tau file from the community ceremony.
- A chain provider (Blockfrost or Koios) for mainnet.

## 14. Open questions and defaults

None of these blocks M0. Each has a default that the builder can assume.

| # | Question | Default for the build | Must be decided before |
|---|---|---|---|
| 1 | Which data source screens Cardano addresses for the compliance list? | In M0 the operator approves its own deposits by hand | M1 |
| 2 | What is the protocol fee? | 0 | M2 |
| 3 | Which entity operates the pool, and which jurisdiction reviews it? | Not needed for a canary with team funds | M1 |
| 4 | Which TypeScript transaction library do we standardize on? | Mesh SDK. The first build task confirms it | First week of M0 |
| 5 | Do we propose a `zbase` transfer method upstream in x402? | Not needed for stealth mode | M1 |
| 6 | How does the relayer quote and fund the minimum ADA for stablecoin payouts? | The relayer fronts the ADA and is repaid in tokens | M2 |
| 7 | Does an auditor accept the Poseidon parameter set (56 partial rounds)? | Use `poseidon-bls12381-circom` 1.0.0 | The M2 audit |
| 8 | Which stablecoin pool ships first, USDM or USDCx? | USDCx if Masumi is the main target, otherwise USDM | M2 |
| 9 | Which license does this repo use? | Not set. zBase on Base uses Apache-2.0 | The repo goes public |

## 15. Landscape

| Project | What it is | Status | Gap that zx402 fills |
|---|---|---|---|
| x402 on Cardano (`@x402/cardano` 2.28.0) | HTTP 402 payments with an `exact` scheme | On npm since September 2026 | All payments are public |
| Masumi | Agent registry and `vested_pay` escrow | Live | Escrow funding is public |
| Subbit x402 | x402 batch settlement over payment channels | Preprod research spike | Channel funding is public |
| Seedelf | Stealth addresses with Schnorr proofs | Mainnet | Hides the receiver, not the funder. No value hiding |
| Lovejoin | Mixer for fixed 10 ADA boxes, no operator | Mainnet since 2026-09-26, unaudited | Fixed amounts, no compliance list, no x402 |
| Encoins v2 with zkFold accumulator | Fixed-denomination privacy relay | Preprod only | Fixed amounts, no x402 |
| TrustLevel ZK lending | Groth16 proofs in Aiken validators | Preprod | Lending, not payments |
| Pulse | Private notes in a depth 32 tree | In development | Not agent payments |
| Midnight | Partner chain for private computation | Mainnet live, no x402 support, no trustless bridge | Not L1 settlement |

## 16. Glossary

| Term | Meaning |
|---|---|
| Pool | The on-chain shielded pool for one asset. |
| Note | A private balance record inside the pool. |
| Commitment | The public fingerprint of a note. It is a leaf in the tree. |
| Nullifier hash | A public tag that marks a note as spent. |
| Label | A unique ID for a deposit. Change notes keep the label of their deposit. |
| ASP | Association Set Provider. It publishes the root of approved labels. |
| Settle | A private payment transaction out of the pool. |
| Ragequit | A public exit by the original depositor. |
| Relayer | The service that builds and submits pool transactions, so the agent's wallet never appears. |
| Crank | The job that inserts pending entries into the tree. Anyone can run it. |
| Intent | The payment instruction that the proof is bound to. |

## 17. M0 acceptance criteria

M0 is done when all of these hold. Each maps to a step in [RUNBOOK-M0.md](./RUNBOOK-M0.md).

1. A team wallet deposits 10 ADA with one ordinary transaction, and the note appears after Insert (runbook steps 7 and 8).
2. The agent pays a stock x402 seller 3 ADA in stealth mode. The paying wallet appears in neither transaction (step 10).
3. A second payment from the change note works (step 11).
4. An unapproved deposit cannot settle privately, and its owner exits by ragequit (step 12).
5. A deposit is refunded before Insert (step 13).
6. Pausing deposits blocks new deposits and does not block payments or exits (step 14).
7. Every case in the negative suite fails in evaluation (step 15).
8. Measured costs are recorded, and they meet NFR-6 and NFR-9, or the Spec is updated with the real numbers (step 16).
9. The solvency monitor reports no gap for 7 days (step 17).
10. Every test in [TEST-PLAN.md](./TEST-PLAN.md) passes in CI.

## Revision history

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-10-06 | First draft. |
| 1.0 | 2026-10-06 | Owner approved. Stealth mode is the default x402 path. Open questions now carry defaults. Added M0 acceptance criteria. |
