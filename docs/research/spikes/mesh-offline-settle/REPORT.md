# WP5 offline Settle spike

Date: 2026-10-06. Result: DONE_WITH_CONCERNS.

Use Mesh for `packages/txlib`, with an explicit evaluator boundary and a final signed-transaction fee check.
Mesh builds, balances, signs, chains, and preserves this Settle-shaped transaction fully offline.
Its Scalus evaluator also accepts the valid transaction and rejects the invalid transaction.
Exact CPU agreement with Aiken remains unresolved, so this is not an unconditional evaluation-parity verdict.

No provider, network query, mainnet connection, submission, or real key was used.
Addresses use mainnet network ID 1 only to exercise the required encoding.
The script checks transaction shape. It does not verify Groth16 or nullifier proofs.

## Probe results

| Probe | Verdict | Evidence |
| --- | --- | --- |
| 1. Offline build | PASS | `MeshTxBuilder.complete()` balances two supplied inputs without fetcher, submitter, or evaluator. |
| 2. Shape | PASS | Final signed CBOR has the required inputs, references, datum, signer, expiry, ordered outputs, and no forbidden fields. |
| 3. Input ordering | PASS | Fee input before pool gives Spend[1]; fee input after pool gives Spend[0]. Both evaluate in Aiken. |
| 4. Offline evaluation | PARTIAL | Aiken and Scalus agree on success, failure, and memory. Scalus charges 6,243 more CPU steps. |
| 5. Budget and fee | PASS | Measured budgets plus 10% work. Automatic fee is 249,791 lovelace; independent minimum is 248,559. |
| 6. Raw-key signing | PASS | Noble signs the body hash with a generated 32-byte seed. The attached witness verifies. |
| 7. Chaining | PASS | Transaction two spends unsubmitted output 0 and change output 5. Aiken and Scalus evaluate it. |
| 8. Byte stability | PASS | Mesh parse/serialize and `fromCore` preserve bytes and ID. Evolution's default round trip also preserves both. |
| 9. Sizes | PASS | Signed base is 1,114 bytes. Adding the 760-byte nullifier placeholder gives 1,899 bytes. Script is 1,464 bytes. |
| 10. x402 signer contract | PASS | Installed signer types accept base64 signed CBOR and a consumed `txHashHex#index` nonce without Evolution-specific types. |

The executable prints PASS for probe 4 because both evaluators execute and reject correctly, and the comparison completes.
It also reports one concern. The table marks exact evaluator parity PARTIAL instead of hiding the difference.

## Installed versions and APIs

| Package | Version |
| --- | --- |
| `@meshsdk/core` | 1.9.1 |
| `@meshsdk/core-cst` | 1.9.1 |
| `@cardano-sdk/core` | 0.46.12 |
| `scalus` | 0.17.0 |
| `@evolution-sdk/evolution` | 0.5.17 |
| `@x402/cardano` | 2.28.0 |
| `@noble/curves` | 2.4.0 |
| `@aiken-lang/aiken` | 1.1.24 |

Installed JavaScript and type definitions are the API authority for this report.
Mesh 1.9.1 defaults to `CardanoSDKSerializer` from `@meshsdk/core-cst`, backed by `@cardano-sdk/core`.
Its constructor enables Conway serialization. No alternate serializer option is required.

The example uses these Mesh builder methods:

- `setNetwork('mainnet')` and constructor `params` supply cost models and the SPEC fee parameters without fetching them.
- `spendingPlutusScriptV3()`, `txIn()`, `spendingTxInReference()`, `txInInlineDatumPresent()`, and `txInRedeemerValue()` describe the script spend.
- `readOnlyTxInReference()`, `txInCollateral()`, `requiredSignerHash()`, and `invalidHereafter()` describe the remaining transaction requirements.
- `txOut()`, `txOutInlineDatumValue()`, `changeAddress()`, and `complete()` produce balanced CBOR in the required output order.
- `setFee()` also accepts the independently calculated minimum, and that transaction evaluates successfully.

Set `scriptSize=0` explicitly for ordinary inputs and references.
For the spending reference, supply its actual ledger script byte length and script hash.
Mesh needs that length to charge the reference script fee without fetching the UTXO.
The length here is 1,464 bytes, including the inner CBOR byte-string prefix.
Raw Flat code is 1,461 bytes; double-wrapped API input is 1,467 bytes.

Normalize blueprint code with `normalizePlutusScript(code, 'DoubleCBOR')` before passing it to Mesh's script-reference helpers.
`resolveScriptRef()` removes one CBOR layer, so passing the blueprint's single layer produces the wrong hash and unusable code.
The example asserts that `toScriptRef(script).hash()` equals the blueprint hash.

Mesh does not add a collateral return or total-collateral field by default in this example.
The supplied collateral remains the full 5 ADA UTXO.
Production code can explicitly use `setTotalCollateral()` and `setCollateralReturnAddress()`; those options were not exercised here.

## Fixtures and validator

The pool input contains 100 ADA and one synthetic NFT. The fee input contains 20 ADA, and collateral contains 5 ADA.
One reference UTXO carries the compiled script. Two more carry inline integers 0 and 1.
Output 0 returns 86 ADA and the NFT to the pool, with counter 1.
Outputs 1 through 4 pay 2, 3, 4, and 5 ADA to four distinct enterprise key addresses.
Output 5 contains fee change. The upper validity slot is 200,000,000.

The datum is constructor 0 with `[counter, fourPayeeKeyHashes]`.
The redeemer is constructor 0 with `[counter, proof192, signerKeyHash, nullifierPlaceholder]`.
The last field is empty normally and 760 bytes for probe 9.
This preserves one validator across the size comparison while supplying the signer hash required by the brief.

The validator reads its own inline datum and a reference datum, requires the finite bound and signer, and checks every payout position and amount.
It also checks the 192-byte proof length, incremented counter, unchanged payees, and empty mint, withdrawals, and certificates.
The synthetic proof bytes are never represented as cryptographic evidence.

## Evaluation and measured costs

`sim.ts` invokes the pinned root Aiken executable with these values:

```text
zero time: 1596059091000
zero slot: 4492800
slot length: 1000
```

Aiken receives transaction CBOR hex and two parallel CBOR arrays.
The first array contains all spent, reference, and collateral input references. The second contains their resolved outputs in matching order.
The helper uses unique temporary directories inside `stub/build/` and removes them in `finally`.
It returns `{ tag, index, budget: { mem, steps } }[]`, or throws the CLI error including its script-failure message.

Aiken 1.1.24 returns an ordered JSON array of `{ mem, cpu, traces }`, without redeemer identifiers.
The helper associates results with redeemers sorted by ledger tag and index.
This spike exercises one spending redeemer; multiple redeemer purposes remain untested.

| Transaction | Aiken memory | Aiken CPU steps | Scalus CPU steps |
| --- | ---: | ---: | ---: |
| Base Settle | 235,820 | 91,210,662 | 91,216,905 |
| Chained Settle | 240,570 | 92,860,358 | Evaluated, not used as a recorded cost baseline |
| 760-byte nullifier placeholder | 238,355 | 92,167,956 | Not measured |

Scalus base memory is also 235,820. Its CPU difference is 6,243 steps, approximately 0.00685%.
The underlying cause could be evaluator or default cost-model differences; this run did not establish which.
No live cost models were fetched.
For local pass/fail and reference costs, trust the pinned Aiken CLI first and keep the Scalus comparison as a diagnostic.
Neither local default proves acceptance under current ledger parameters. Production submission still needs provider evaluation with those parameters.

`OfflineEvaluatorScalus.evaluateTx(cbor, resolvedUtxos)` runs without network lookups.
Its required fetcher argument is a rejecting stub, and global `fetch` also rejects calls.
For chaining, `evaluateTx(child, collateralAndReferences, [parent])` resolves the parent's outputs directly.

Changing only output 0's counter from 1 to 2 makes both evaluators fail.
Aiken reports `failed script execution` and `the validator crashed / exited prematurely`.
The test checks that script error specifically, rather than accepting arbitrary resolution or process errors.

Evolution's installed builder exposes an `Evaluator` interface, but no independent local evaluator is included in this installation.
Its build phase requires a supplied evaluator or a provider evaluator when scripts need evaluation.
As a fallback probe, both valid and invalid transactions were decoded and serialized with Evolution, then evaluated through `sim.ts`.
The valid case returns the same Aiken units; the invalid case reports the same script failure.
This demonstrates an external evaluator path, not an independent resolution of the Scalus discrepancy.
A complete alternate Evolution build was unnecessary because Mesh's builder probes pass.

## Budget, fee, and sizes

The first build uses placeholder budgets of 16,000,000 memory and 9,000,000,000 CPU steps.
The second build uses the larger measurement from either evaluator, multiplied by 110/100 and rounded upward.
Its budgets are 259,402 memory and 100,338,596 CPU steps.
The final signed transaction is evaluated again and stays within those budgets.

The independent formula uses integer arithmetic and the signed CBOR length:

```text
size fee      = 155381 + 44 * 1114                         = 204397
execution fee = ceil(259402 * 0.0577 + 100338596 * 0.0000721) = 22202
reference fee = 1464 * 15                                  = 21960
minimum fee                                                 = 248559 lovelace
Mesh automatic fee                                          = 249791 lovelace
automatic surplus                                          =   1232 lovelace
```

The implementation includes the 25,600-byte reference tiers, increasing the price by 6/5 per tier.
This script uses only the first tier; larger-tier agreement was not experimentally established.
Setting its reported reference size to zero lowers Mesh's fee by exactly 21,960 lovelace.
That comparison is deliberately underpriced and is never submitted.

Mesh's `calculateFee()` after completion agrees with 248,559; automatic coin selection retained a conservative 1,232-lovelace surplus.
No claim is made about the internal cause of that surplus.
An explicit `setFee('248559')` rebuild remains balanced, has the independent minimum fee, and evaluates successfully.
The main returned example retains Mesh's conservative automatic fee.

| Artifact | Bytes |
| --- | ---: |
| Signed transaction with 192-byte proof and empty nullifier field | 1,114 |
| Signed transaction with 192-byte proof and 760-byte nullifier field | 1,899 |
| Compiled ledger script | 1,464 |
| Raw Flat script | 1,461 |

The larger signed transaction's automatic fee is 284,331 lovelace. Its independent minimum is 283,099 lovelace.
These are stub measurements, not estimates of the real pool validator or nullifier proof representation.

## Raw seeds and x402 contract

Generate a throwaway 32-byte seed in memory with `randomBytes(32)`.
Derive its public key with `ed25519.getPublicKey(seed)` from `@noble/curves/ed25519.js`.
Compute the payment key hash with BLAKE2b-224 over that public key.
Call `serializeAddress({ pubKeyHash }, 1)` to obtain an enterprise mainnet `addr1v...` address.

For signing, parse CBOR with the core-cst `Transaction` class and use its `getId()` as the body hash.
Sign the hash bytes with `ed25519.sign()`.
Construct a `VkeyWitness`, put it in `CborSet.fromCore(..., VkeyWitness.fromCore)`, and update the transaction witness set.
The example has one key owner for the fee input, collateral, and required signer, so one witness fully covers its key requirements.
For additional owners, merge their witnesses instead of replacing the set as this single-key example does.
The script remains a reference input, and the spending redeemer remains present.
Only public transaction data and measurements are emitted. The seed is never written and is cleared after the probes.

Installed `@x402/cardano` declares the following shape. `ResourceInfo` comes from `@x402/core/types`.

```ts
interface ClientCardanoSigner {
  getAddress(): string;
  buildAndSignPaymentTransaction(
    input: ClientCardanoSignInput,
  ): Promise<ClientCardanoSignResult> | ClientCardanoSignResult;
}

interface ClientCardanoSignInput {
  network: string;
  payTo: string;
  asset: string;
  amount: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
  resource?: ResourceInfo;
}

interface ClientCardanoSignResult {
  transaction: string;
  nonce: string;
}
```

`network` uses an identifier such as `cardano:mainnet`. `payTo` and `getAddress()` are bech32 addresses.
The type comment describes token `asset` as `policyId.assetNameHex`; the scheme uses `lovelace` for ADA.
`amount` is a decimal string in smallest asset units. `maxTimeoutSeconds` is the maximum lifetime in seconds.
`extra` carries method-specific payment metadata, and `resource` describes the protected resource.

`transaction` is the signed transaction's CBOR encoded as base64, not CBOR hex and not a witness set.
`nonce` is `txHashHex#index` for an input actually consumed by that transaction.
The result must remain unbroadcast because the facilitator submits it.
All required witnesses must already be present; the facilitator does not sign for the client.
The signer interface contains no Evolution or Mesh classes. Only the optional `ResourceInfo` type comes from another package.

A transaction signed using probe 6 can supply these string fields after conversion from hex bytes to base64.
For the default stealth flow, use this signing technique for the plain leg-2 key payment from the one-time UTXO.
The four-payout stub transaction is not itself a valid substitute for those requested payment requirements.
Facilitator acceptance, nonce lookups, confirmation timing, and a complete x402 payment were not tested.

## Proposed transaction-library boundaries

Keep provider types independent from either SDK. One possible interface is:

```ts
interface Provider {
  getUtxos(address: string): Promise<ResolvedUtxo[]>;
  getUtxosByRefs(refs: UtxoRef[]): Promise<ResolvedUtxo[]>;
  getProtocolParameters(): Promise<ProtocolParameters>;
  evaluate(
    cborHex: string,
    options?: { additionalUtxos?: ResolvedUtxo[] },
  ): Promise<ExecutionUnits[]>;
  submit(cborHex: string): Promise<string>;
}
```

`ProtocolParameters` must include fees, limits, collateral rules, cost models, and slot-time configuration.
`ExecutionUnits` should carry the redeemer purpose and index as well as CPU and memory counts.
Adapters must explicitly support additional unsubmitted UTXOs or return an unsupported-capability error.
They must not silently discard those UTXOs. This spike does not prove any remote provider supports them.

An in-memory fake chain can own a map keyed by transaction hash and output index.
Its evaluate method resolves spent, reference, and collateral inputs from that map plus the explicitly supplied additional UTXOs.
It passes the complete resolution to `sim.ts` without mutating the map.
Its apply method should check input existence and uniqueness, signatures, value conservation, validity, minimum fee, output minimums, and budgets.
After successful evaluation, it consumes only spent inputs and inserts outputs under the body hash and their original indices.
Reference inputs and collateral stay unspent on success. Failed script transactions should be rejected without map changes in the initial test implementation.
If collateral-only failure application becomes necessary, add it as an explicit separate mode with tests.

The fake chain is a proposed interface, not a ledger implementation delivered by this spike.
Aiken simulation alone does not validate every ledger rule or signature.

## Decisions, limitations, and pitfalls

- The brief fixes 100 ADA, one NFT, 5 ADA collateral, and proof lengths; other values use the fixtures documented above.
- The empty fourth redeemer field avoids switching validators for the size probe. It contributes one encoded empty byte string to the baseline.
- Fixed synthetic transaction hashes exercise both input orders. Fresh signing seeds change IDs between runs while preserving measured sizes and costs.
- The same throwaway key owns fees, collateral, and the signer requirement. Payout hashes are synthetic and are never spent.
- Mainnet network encoding and the specified slot settings do not authorize network access. All state is supplied by hand.
- A first cache-copy command used the wrong working directory. Its empty nested task directory was removed; the corrected copy uses absolute paths.
- Passing single-wrapped blueprint code to Mesh produced the wrong script hash and Aiken's `expected bytes` error. Double wrapping fixes it.
- Aiken's JSON output omits redeemer identifiers. The helper reconstructs them from the transaction instead of expecting a nested `redeemer` object.
- Strict CPU equality initially failed. The discrepancy remains explicit, and budgets cover the greater observation with a 10% margin.
- An initial error assertion used the wrong phrase. The final negative checks match Aiken's observed `failed script execution` message.
- Strict TypeScript checking required the Mesh `Data` type instead of a broad `object` parameter.
- Aiken formatting initially failed. Only the stub validator was formatted, and its focused formatting check now passes.
- The copied package cache included the trie library. Aiken accepted it; only stdlib appears in the stub manifest and lockfile.
- Code graph discovery was unavailable under the tool approval policy. Installed definitions and targeted source reads supplied the evidence.
- The lane rule forbids changes to shared documentation, so measurements and decisions are recorded here instead of `docs/measurements.md` or SPEC.
- User rules prohibit extra agents and Git mutation. Review was a local self-review; no review agent, stage, commit, or push was run.
- Tests use the installed transitive packages. A real `packages/txlib/package.json` should declare the packages it imports directly.

## Verification

Initial red run:

```text
node --import tsx docs/research/spikes/mesh-offline-settle/settle-shape.spike.ts
FAIL 1: TX-05: offline Settle CBOR is missing
```

The negative test was also verified by temporarily removing only the counter-increment validator condition and rebuilding:

```text
FAIL 4: Offline evaluation (TX-05): Missing expected exception.
Checks: 9 passed, 1 failed, 1 concerns
```

Restoring the condition and rebuilding returns ten passing probes with one recorded evaluator concern.
The final required command is:

```bash
node --import tsx docs/research/spikes/mesh-offline-settle/settle-shape.spike.ts
```

Expected verified summary: `Checks: 10 passed, 0 failed, 1 concerns`, exit 0.
The stub build reports `0 errors, 0 warnings`.
Focused Aiken formatting and strict TypeScript checks pass.
No task process remains running, and simulation temporary directories are removed after each invocation.
