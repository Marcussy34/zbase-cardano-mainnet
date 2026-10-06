# zBase Cardano: Measurements

Fill this file during M0. It replaces the estimates in [SPEC.md](./SPEC.md) section 10.
Measured values that are already known are in [research/2026-10-06-measurements.md](./research/2026-10-06-measurements.md).

## 1. Circuits

| Circuit | Constraints | Setup power | Proving time, 4-core machine | Proving key size |
|---|---|---|---|---|
| `spend` | | | | |
| `insert` | | | | |
| `ragequit` | | | | |

## 2. Scripts

| Script | Size in bytes | Script hash |
|---|---|---|
| `pool` | | |
| `deposit` | | |
| `config` | | |
| `asp` | | |
| `nft` | | |

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

## 4. End-to-end timings

| Flow | Time from request to one confirmation |
|---|---|
| Stealth payment, one-time key funded on demand | |
| Stealth payment, one-time key funded ahead | |

## 5. Differences from the Spec estimates

List each estimate in SPEC section 10 that was wrong by more than 20%, and update the Spec.
