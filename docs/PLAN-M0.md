# zx402 M0 Mainnet Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Granularity note:** this plan is a work breakdown for a human-led build. Each work package fixes its files, interfaces, tests, and done criteria. Before you code a work package, expand its tasks into test-first steps of a few minutes each.

**Goal:** a capped ADA pool on Cardano mainnet where a team wallet can deposit, pay a stock x402 seller privately in stealth mode, and exit by ragequit.

**Architecture:** notes are commitments in a Poseidon Merkle tree, and funds sit in one pool UTXO. A Groth16 proof over BLS12-381 authorizes each private payment, and a second proof covers each tree update, so the validator never hashes Poseidon. A relayer submits pool transactions, and the SDK proves on the agent's machine.

**Tech Stack:**

- Circuits: circom 2.2.x with `--prime bls12381 --O2`, snarkjs 0.7.6, `poseidon-bls12381-circom` 1.0.0.
- Contracts: Aiken 1.1.24 or later on Plutus V3, stdlib v4.0.0, `aiken-lang/merkle-patricia-forestry` 2.1.0.
- Off-chain: TypeScript on Node 22 or later, Mesh SDK 1.9.x, `@x402/cardano` 2.28.x, `@noble/curves` 2.4.0, Blockfrost.

**Spec:** [SPEC.md](./SPEC.md) v1.0. Read it with [PRD.md](./PRD.md), [TEST-PLAN.md](./TEST-PLAN.md), and [TEST-VECTORS.md](./TEST-VECTORS.md).

## Global Constraints

These come from the Spec. Every task inherits them.

- Curve BLS12-381. Field prime `r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001`.
- Hashes in circuits and SDK: `Poseidon255` from `poseidon-bls12381-circom` 1.0.0 only. Never `circomlibjs`.
- The validator never computes Poseidon.
- `TREE_DEPTH = 32`, `ROOT_HISTORY = 16`, `QUEUE_MAX = 8`, `INSERT_BATCH = 4`, `MAX_PAYOUTS = 4`, `VALUE_BITS = 64`.
- `POOL_RESERVE = 6,000,000` lovelace. `MAX_DEPOSIT_FEE_BPS = 100`. `MAX_SETTLE_FEE_BPS = 1000`. `MAX_CRANK_FEE = 1,000,000` lovelace.
- M0 config: minimum deposit 5 ADA, maximum deposit 50 ADA, pool cap 500 ADA, both fees 0, crank fee 0.3 ADA.
- Every public input is range-checked on-chain: `0 <= x < r`.
- In Aiken, curve points never pass through `Option`, lists, tuples, or records. Each wrap costs an extra compress and uncompress.
- No pool transaction mints, withdraws rewards, or carries a certificate.
- Script addresses carry no stake credential. Scripts are immutable. Verification keys are script parameters.
- Label and context use the byte encodings in SPEC 4.4 and 4.5. They must match TEST-VECTORS.
- Test IDs come from TEST-PLAN. Each Spec rule has a passing and a failing test.
- Network testing happens on mainnet with capped own funds. Evaluate every transaction before submit.
- Docs and comments use no em dashes.

## Review Focus

These five cases are the most likely to bite a real user. Each has a test in the work package that owns the code.

1. **A public input of `x + r`.** The verifier must reject it, or a note can be spent twice. Test VER-01 in WP3.
2. **A proof that went stale.** The state root left the history, or the ASP root changed. The relayer must return `stale_root` or `stale_asp_root`, and the SDK must prove again. Tests REL-04 in WP8 and SDK-06 in WP9.
3. **Someone else spends the pool UTXO first, or the chain rolls back.** The relayer must rebuild and resubmit. The indexer must roll back. Tests REL-05 in WP8 and IDX-03 in WP6.
4. **A deposit that Insert would reject.** A bad datum, a zero precommitment, or an amount outside the limits. The crank must skip it and never stall. Tests POOL-I3 and POOL-I4 in WP3 and CRK-03 in WP7.
5. **A payout the ledger or the Spec forbids.** An amount under the minimum ADA, or a pointer address. The SDK must refuse before proving. Tests SDK-07 in WP9 and ENC-04 in WP3.

---

## File structure

```text
package.json                      workspace root (npm workspaces)
artifacts/manifest.json           hashes of circuits, keys, and scripts
artifacts/public-signals.json     public signal order for each circuit

circuits/
  src/lib/note.circom             Precommitment, Commitment, NullifierHash
  src/lib/merkle.circom           MerkleRoot, MerkleAppend
  src/spend.circom                Spend(depth)
  src/insert.circom               Insert(depth, batch)
  src/ragequit.circom             Ragequit(depth)
  src/main/spend.circom           component main for spend
  src/main/insert.circom          component main for insert
  src/main/ragequit.circom        component main for ragequit
  scripts/build.sh                compile all circuits
  scripts/setup-dev.sh            development keys, never for real funds
  test/*.test.ts                  CIR tests

contracts/
  aiken.toml
  lib/zbase/constants.ak
  lib/zbase/types.ak              datums, redeemers, intent
  lib/zbase/groth16.ak            verifier module, rules V1 to V6
  lib/zbase/encoding.ak           label, context, nullifier_key
  lib/zbase/pool/common.ak        rules P1 to P5, value helpers
  lib/zbase/pool/insert.ak        rules I1 to I12
  lib/zbase/pool/settle.ak        rules S1 to S15
  lib/zbase/pool/ragequit.ak      rules R1 to R8
  lib/zbase/pool/fees.ak          rules C1 to C4
  lib/zbase/fixtures.ak           generated proof fixtures for tests
  validators/pool.ak
  validators/deposit.ak
  validators/config.ak
  validators/asp.ak
  validators/nft.ak

packages/crypto/src/
  field.ts poseidon.ts note.ts tree.ts encoding.ts points.ts keys.ts
packages/txlib/src/
  context.ts init.ts deposit.ts insert.ts settle.ts ragequit.ts admin.ts stealth.ts
packages/sdk/src/
  client.ts notes.ts sync.ts prover.ts x402.ts

services/indexer/  services/relayer/  services/crank/  services/asp/
ops/ceremony/      ops/deploy/        ops/monitor/
```

## Order and effort

| Work package | Depends on | Effort (person-days, estimate) |
|---|---|---|
| WP0 Workspace and toolchain | none | 0.5 |
| WP1 Crypto library | WP0 | 1.5 |
| WP2 Circuits | WP1 | 3 |
| WP3 Contracts | WP1, and WP2 for pool tests | 4 |
| WP4 Proof fixtures | WP2, WP3 | 0.5 |
| WP5 Transaction builders | WP3 | 2.5 |
| WP6 Indexer | WP5 | 1.5 |
| WP7 Crank | WP2, WP5, WP6 | 1 |
| WP8 Relayer | WP5, WP6 | 2 |
| WP9 SDK | WP1, WP2, WP8 | 2.5 |
| WP10 ASP tool | WP5, WP6 | 0.5 |
| WP11 Ceremony, deploy, canary | all | 2 |

Two lanes can run in parallel after WP1:

- **Lane A:** WP2, then WP4, then WP7.
- **Lane B:** the verifier and encoding parts of WP3, then the rest of WP3, WP5, WP6, WP8.

Total is about 21 person-days. With two lanes the critical path is about 12 working days. Both numbers are estimates.

---

## WP0: Workspace and toolchain

**Files:** `package.json`, `tsconfig.base.json`, `.nvmrc`, `contracts/aiken.toml`, CI workflow.

**Interfaces:**
- Consumes: [SETUP.md](./SETUP.md).
- Produces: `npm test` runs every package. `aiken check` runs in `contracts/`.

- [ ] Follow SETUP.md and confirm every version check passes.
- [ ] Create the npm workspace with the folders from the file structure.
- [ ] Create the Aiken project with Aiken 1.1.24, stdlib v4.0.0, and Merkle Patricia Forestry 2.1.0, as SETUP.md lists.
- [ ] Add one trivial passing test per package so the test commands are proven.
- [ ] Add CI that runs `npm test` and `aiken check` on every push.

**Done when:** a fresh clone passes `npm ci && npm test` and `aiken check`.

## WP1: Crypto library (`packages/crypto`)

**Files:** `field.ts`, `poseidon.ts`, `note.ts`, `tree.ts`, `encoding.ts`, `points.ts`, `keys.ts`, and one test file per module.

**Interfaces:**
- Consumes: `poseidon-bls12381`, `@noble/curves`, `@noble/hashes`.
- Produces:

```ts
// field.ts
export const R: bigint;
export function isCanonical(x: bigint): boolean;          // 0 <= x < R

// poseidon.ts
export function h1(a: bigint): bigint;
export function h2(a: bigint, b: bigint): bigint;
export function h3(a: bigint, b: bigint, c: bigint): bigint;

// note.ts
export interface Note { value: bigint; label: bigint; nullifier: bigint; secret: bigint }
export function precommitment(nullifier: bigint, secret: bigint): bigint;
export function commitment(note: Note): bigint;
export function nullifierHash(nullifier: bigint): bigint;

// tree.ts
export const TREE_DEPTH = 32;
export const ZERO_HASHES: readonly bigint[];               // Z[0] to Z[32]
export class MerkleTree {
  static empty(): MerkleTree;
  append(leaf: bigint): number;                            // returns the leaf index
  set(index: number, leaf: bigint): void;                  // used for ASP removals
  get size(): number;
  get root(): bigint;
  path(index: number): { siblings: bigint[]; indexBits: number[] };
}

// encoding.ts
export interface Credential { kind: 'key' | 'script'; hash: Uint8Array }
export interface PayoutAddress { payment: Credential; stake: Credential | null }
export interface Payout { address: PayoutAddress; amount: bigint; datumHash: Uint8Array | null }
export interface SettleIntent {
  poolId: Uint8Array; payouts: Payout[]; relayer: Uint8Array | null; validUntil: bigint;
}
export function labelFor(a: {
  poolId: Uint8Array; txId: Uint8Array; outputIndex: number; refundKeyHash: Uint8Array;
}): bigint;
export function intentBytes(intent: SettleIntent): Uint8Array;
export function contextFor(intent: SettleIntent): bigint;
export function nullifierKey(nullifierHash: bigint): Uint8Array;   // 32 bytes, big-endian

// points.ts
export function proofToCardano(proof: SnarkjsProof): { a: Uint8Array; b: Uint8Array; c: Uint8Array };
export function vkToCardano(vk: SnarkjsVk): {
  alpha: Uint8Array; beta: Uint8Array; gamma: Uint8Array; delta: Uint8Array; ic: Uint8Array[];
};

// keys.ts
export function deriveNoteSecrets(seed: Uint8Array, index: number): { nullifier: bigint; secret: bigint };
export function deriveOneTimeKey(seed: Uint8Array, index: number): Uint8Array;   // 32-byte Ed25519 seed
```

- [ ] Write tests CRY-01 to CRY-10 from TEST-VECTORS first. Run them and watch them fail.
- [ ] Implement `field.ts` and `poseidon.ts`. CRY-01 passes.
- [ ] Implement `note.ts` and `tree.ts`. CRY-02, CRY-03, CRY-04 pass.
- [ ] Implement `encoding.ts`. CRY-05, CRY-06, CRY-07, CRY-10 pass.
- [ ] Implement `points.ts`. CRY-08 passes.
- [ ] Implement `keys.ts` with the info strings from SPEC 4.7. CRY-09 passes.

**Done when:** CRY-01 to CRY-10 pass, and no function accepts a value outside its range.

## WP2: Circuits (`circuits`)

**Files:** the circuit files in the file structure, `scripts/build.sh`, `scripts/setup-dev.sh`, `test/spend.test.ts`, `test/insert.test.ts`, `test/ragequit.test.ts`.

**Interfaces:**
- Consumes: `packages/crypto` to build witnesses and expected values.
- Produces:
  - `build/<circuit>.r1cs` and `build/<circuit>_js/<circuit>.wasm` for `spend`, `insert`, `ragequit`.
  - `artifacts/public-signals.json` with these exact orders:
    - `spend`: `newCommitment, nullifierHash, withdrawnValue, stateRoot, aspRoot, context`
    - `insert`: `oldRoot, newRoot, startIndex`, then `v0, l0, x0, v1, l1, x1, v2, l2, x2, v3, l3, x3`
    - `ragequit`: `nullifierHash, stateRoot, value, label`
  - Development proving and verification keys under `build/dev/`. They are for tests only.

- [ ] Write `lib/note.circom` and `lib/merkle.circom`, with test CIR-P01 first.
- [ ] Write `spend.circom`. Write CIR-S00 to CIR-S10 first, one at a time.
- [ ] Write `insert.circom`. Write CIR-I00 to CIR-I08 first, one at a time.
- [ ] Write `ragequit.circom`. Write CIR-R00 to CIR-R03 first.
- [ ] Write `build.sh`. It compiles with `--prime bls12381 --O2` and writes `public-signals.json`. CIR-O01 passes.
- [ ] Write `setup-dev.sh`. It makes development keys with snarkjs on curve `bls12-381`.
- [ ] Record the constraint count of each circuit in `docs/measurements.md`.

**Done when:** every CIR test passes, and the signal order file matches SPEC section 5.

## WP3: Contracts (`contracts`)

**Files:** the Aiken files in the file structure. Tests live next to the code.

**Interfaces:**
- Consumes: vectors from TEST-VECTORS, fixtures from WP4, the signal orders from WP2.
- Produces:

```aiken
// lib/zbase/groth16.ak
pub type VerificationKey {
  alpha: ByteArray, beta: ByteArray, gamma: ByteArray, delta: ByteArray, ic: List<ByteArray>,
}
pub fn verify(vk: VerificationKey, proof: Proof, public: List<Int>) -> Bool

// lib/zbase/encoding.ak
pub fn label(pool_id: ByteArray, deposit_ref: OutputReference, refund: VerificationKeyHash) -> Int
pub fn context(intent: SettleIntent) -> Int
pub fn nullifier_key(nullifier_hash: Int) -> ByteArray

// validators
validator pool(nft_policy: PolicyId, deposit_script: ScriptHash, asset: AssetClass,
               vk_spend: VerificationKey, vk_insert: VerificationKey, vk_ragequit: VerificationKey)
validator deposit(nft_policy: PolicyId)
validator config(nft_policy: PolicyId)
validator asp(nft_policy: PolicyId)
validator nft(seed: OutputReference)
```

  - `plutus.json` blueprint with every validator, used by WP5.

- [ ] Write `groth16.ak`. Write VER-00 to VER-06 first, using TEST-VECTORS section 9.
- [ ] Write `encoding.ak`. Write ENC-01 to ENC-05 first.
- [ ] Write `types.ak` and `constants.ak` exactly as SPEC 6.2 and 6.3.
- [ ] Write the Insert rules. Write POOL-I0 to POOL-I12 first.
- [ ] Write the Settle rules. Write POOL-S0 to POOL-S15 first.
- [ ] Write the Ragequit rules. Write POOL-R0 to POOL-R8 first.
- [ ] Write the CollectFees rules. Write POOL-C0 to POOL-C4 first.
- [ ] Write the common rules. Write POOL-P1 to POOL-P5 first.
- [ ] Write `deposit.ak`, `config.ak`, `asp.ak`, `nft.ak`. Write DEP, CFG, ASP, and NFT tests first.
- [ ] Add the budget tests BUD-01 to BUD-04.
- [ ] Record measured CPU, memory, and script sizes in `docs/measurements.md`.

**Done when:** every VER, ENC, POOL, DEP, CFG, ASP, NFT, and BUD test passes with real proofs.

## WP4: Proof fixtures

**Files:** `contracts/fixtures/gen.mjs`, generated `contracts/lib/zbase/fixtures.ak`.

**Interfaces:**
- Consumes: development keys from WP2, `packages/crypto`.
- Produces: `fixtures.ak` with compressed verification keys and proofs for the cases the POOL tests need. Each fixture carries its public inputs.

- [ ] Write `gen.mjs`. It builds witnesses, proves with snarkjs, converts with `proofToCardano` and `vkToCardano`, and writes `fixtures.ak`.
- [ ] Generate fixtures for: a partial settle, a full settle, a four-payout settle, each Insert shape in CIR-I00, and both ragequit cases.
- [ ] Make generation deterministic, so a rerun gives the same file.

**Done when:** `node contracts/fixtures/gen.mjs` rebuilds `fixtures.ak` with no diff.

## WP5: Transaction builders (`packages/txlib`)

**Files:** `context.ts`, `init.ts`, `deposit.ts`, `insert.ts`, `settle.ts`, `ragequit.ts`, `admin.ts`, `stealth.ts`, tests.

**Interfaces:**
- Consumes: `plutus.json` from WP3, `packages/crypto`, Mesh SDK, a provider.
- Produces:

```ts
export interface ChainContext {
  network: 'mainnet';
  provider: Provider;                 // UTXO lookups, protocol parameters, evaluate, submit
  scripts: DeployedScripts;           // script hashes, addresses, reference script UTXOs
  poolId: Uint8Array;
}
export interface PoolState {
  utxo: UtxoRef; roots: bigint[]; size: number; queue: bigint[];
  nullifierRoot: Uint8Array; feesAccrued: bigint; balance: bigint;
}
export interface BuiltTx { cbor: string; txId: string; fee: bigint; exUnits: { cpu: bigint; mem: bigint } }

export function buildInit(ctx: ChainContext, a: InitArgs): Promise<BuiltTx>;
export function buildDeposit(ctx: ChainContext, a: { amount: bigint; precommitment: bigint; refundKeyHash: Uint8Array }): Promise<BuiltTx>;
export function buildRefund(ctx: ChainContext, a: { deposit: UtxoRef }): Promise<BuiltTx>;
export function buildInsert(ctx: ChainContext, a: { pool: PoolState; flush: number; deposits: DepositUtxo[]; proof: CardanoProof; newRoot: bigint }): Promise<BuiltTx>;
export function buildSettle(ctx: ChainContext, a: { pool: PoolState; proof: CardanoProof; publicInputs: SpendPublicInputs; intent: SettleIntent; nullifierProof: MpfProof }): Promise<BuiltTx>;
export function buildRagequit(ctx: ChainContext, a: RagequitArgs): Promise<BuiltTx>;
export function buildCollectFees(ctx: ChainContext, a: { pool: PoolState; amount: bigint }): Promise<BuiltTx>;
export function buildConfigUpdate(ctx: ChainContext, a: { config: ConfigDatum }): Promise<BuiltTx>;
export function buildAspUpdate(ctx: ChainContext, a: { root: bigint; uri: string }): Promise<BuiltTx>;
export function buildStealthPayment(ctx: ChainContext, a: { oneTimeUtxo: UtxoRef; oneTimeKey: Uint8Array; payTo: string; price: bigint }): Promise<BuiltTx>;
```

- [ ] First task of the whole build: a spike. Build a Settle-shaped transaction with Mesh against a stub validator, and evaluate it through the provider. It must use a reference script, an inline datum, reference inputs, collateral, and a validity bound. If Mesh cannot do it, switch to Evolution SDK and record the decision in the Spec.
- [ ] Write `context.ts` with provider access and datum decoding.
- [ ] Write each builder with its TX test first: TX-01 to TX-09.
- [ ] Every builder evaluates the transaction through the provider and returns the units.
- [ ] Every builder puts the pool output at index 0 and payouts at index 1 and up.

**Done when:** TX-01 to TX-09 pass, and each built transaction evaluates within the BUD bounds.

## WP6: Indexer (`services/indexer`)

**Interfaces:**
- Consumes: Blockfrost, `packages/txlib` datum decoders.
- Produces: the indexer API in SPEC 8.8, and a typed client used by WP7, WP8, and WP9.

- [ ] Write IDX-01 to IDX-03 first, against recorded chain data.
- [ ] Follow the pool and deposit addresses. Store deposits, inserts, settles, and ragequits.
- [ ] Rebuild the state tree, the ASP leaf list, and the nullifier trie from stored events.
- [ ] Handle rollbacks by slot.
- [ ] Serve the four read endpoints.

**Done when:** the rebuilt root and nullifier root equal the on-chain values after every recorded transaction.

## WP7: Crank (`services/crank`)

**Interfaces:**
- Consumes: the indexer client, the `insert` circuit files, `buildInsert`.
- Produces: a process that keeps the queue short and absorbs deposits.

- [ ] Write CRK-01 to CRK-03 first.
- [ ] Select queued notes first, then valid deposits, up to four slots.
- [ ] Build the witness, prove, and call `buildInsert`. Evaluate, then submit.
- [ ] Skip any deposit that fails a local check of rules I3 to I6.

**Done when:** CRK tests pass, and a manual run inserts a note and a deposit on mainnet.

## WP8: Relayer (`services/relayer`)

**Interfaces:**
- Consumes: the indexer client, `buildSettle`, snarkjs verification, the nullifier trie.
- Produces: the relayer API in SPEC 8.8.

- [ ] Write REL-01 to REL-06 first.
- [ ] `POST /v1/quote`: compute the protocol fee and the relayer fee, and return `withdrawn` and `validUntil`.
- [ ] `POST /v1/settle`: check the quote, verify the proof locally, check the intent against the context, build, evaluate, submit.
- [ ] Rebuild the nullifier proof at submit time.
- [ ] Rebuild and resubmit when the pool UTXO was spent by someone else.
- [ ] Chain a second settle on the output of the first.

**Done when:** REL tests pass, and the relayer returns each error code in SPEC 8.8 for its case.

## WP9: SDK (`packages/sdk`)

**Interfaces:**
- Consumes: `packages/crypto`, the `spend` and `ragequit` circuit files, the indexer and relayer clients, `@x402/cardano`.
- Produces:

```ts
export function createZbaseCardano(cfg: {
  network: 'cardano:mainnet'; relayerUrl: string; indexerUrl: string; seed: Uint8Array;
  minAspSetSize?: number;            // default 10
}): ZbaseCardano;

export interface ZbaseCardano {
  prepareDeposit(a: { amount: bigint; refundKeyHash: Uint8Array }): DepositPrep;   // address, inline datum, note index
  waitForNote(prep: DepositPrep): Promise<OwnedNote>;
  listNotes(): Promise<OwnedNote[]>;
  settlePrivately(a: { note: OwnedNote; payouts: Payout[] }): Promise<{ txHash: string; change: OwnedNote }>;
  ragequit(a: { note: OwnedNote; signer: TxSigner }): Promise<{ txHash: string }>;
  x402Signer(a: { mode: 'stealth' }): ClientCardanoSigner;
}
```

- [ ] Write SDK-01 to SDK-08 first.
- [ ] Notes store with the lifecycle states in SPEC 8.7.
- [ ] Bulk sync of leaves, ASP leaves, and nullifiers.
- [ ] Local prover that checks file hashes against `artifacts/manifest.json`.
- [ ] `settlePrivately` with quote, proof, submit, and stale-proof retry.
- [ ] Stealth signer: settle to a one-time key, wait for one block, then return the leg-2 payment.
- [ ] `ragequit`.

**Done when:** SDK tests pass, and the stealth signer pays a stock x402 seller on mainnet.

## WP10: ASP tool (`services/asp`)

- [ ] A command lists deposits and their funding addresses.
- [ ] A command approves or removes labels, rebuilds the ASP tree, and submits `buildAspUpdate`.
- [ ] The label list is written to a file and published at the `uri`.

**Done when:** an approved label can settle, and a removed label cannot.

## WP11: Ceremony, deploy, and canary (`ops`)

- [ ] Run [CEREMONY.md](./CEREMONY.md) for the three circuits and commit `artifacts/manifest.json`.
- [ ] Build the validators with the ceremony keys and record the script hashes.
- [ ] Write the deploy scripts for reference scripts and Init.
- [ ] Write the solvency monitor. MON-01 passes.
- [ ] Run [RUNBOOK-M0.md](./RUNBOOK-M0.md) end to end.
- [ ] Fill in [measurements.md](./measurements.md) and update the estimates in the Spec.

**Done when:** every runbook step passes, and the monitor stays green for 7 days.

---

## M0 definition of done

1. Every test in TEST-PLAN passes in CI.
2. Every runbook step passes on mainnet.
3. `docs/measurements.md` holds measured units, sizes, and fees, and the Spec estimates are updated.
4. `artifacts/manifest.json` matches the deployed script hashes.
5. The items in SPEC section 17 are each marked verified or have a written finding.
