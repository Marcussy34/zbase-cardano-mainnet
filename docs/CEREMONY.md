# zx402: Setup Ceremony

| Field | Value |
|---|---|
| Status | v1.0, 2026-10-06 |
| Applies to | The three circuits: `spend`, `insert`, `ragequit` |
| Companions | [SPEC.md](./SPEC.md) section 11, [RUNBOOK.md](./RUNBOOK.md) |

Groth16 needs a setup for each circuit. Whoever knows all the setup secrets can forge proofs and drain the pool.
The ceremony spreads those secrets over several people. It stays safe if at least one of them destroys their secret.

CAUTION: a pool whose setup had one contributor can be drained by that person. Never take outside funds on such a pool.

## 1. Rules

- Each contributor works on their own machine.
- Each contributor types fresh random text and never stores it.
- Nobody reuses a proving key between pools.
- Every file hash goes into `artifacts/manifest.json`.
- A circuit change after the ceremony means a new ceremony and a new pool.
- The `r1cs` files come from a build with `--prime bls12381 --O2`. A snarkjs setup cannot be reproduced, so keep every key file safe.

| Release | Contributors |
|---|---|
| M0 canary, own funds only | Three team members, then a public beacon |
| M1 and later | A public ceremony with outside contributors, then a public beacon |

## 2. Phase 1: powers of tau

Phase 1 does not depend on the circuit. We reuse a public file.

1. Get the BLS12-381 file from the community ceremony at `github.com/p0tion-tools/cardano-ppot`. It must cover at least 2^17 constraints.
2. Verify it:

```bash
snarkjs powersoftau verify pot_final.ptau
```

3. Record its SHA-256 hash in the manifest.

If the file is not prepared for phase 2, prepare it first:

```bash
snarkjs powersoftau prepare phase2 pot_beacon.ptau pot_final.ptau -v
```

The source, format, and hash of this file are item 6 in SPEC section 17. Verify them before the M0 ceremony.

## 3. Phase 2: one run per circuit

The steps below use `spend`. Repeat them for `insert` and `ragequit`.

1. The coordinator creates the first key:

```bash
snarkjs groth16 setup build/spend.r1cs pot_final.ptau spend_0000.zkey
```

2. Contributor 1 adds randomness and passes the file on:

```bash
snarkjs zkey contribute spend_0000.zkey spend_0001.zkey --name="contributor 1" -v
```

3. Contributor 2 does the same on another machine:

```bash
snarkjs zkey contribute spend_0001.zkey spend_0002.zkey --name="contributor 2" -v
```

4. Contributor 3 does the same:

```bash
snarkjs zkey contribute spend_0002.zkey spend_0003.zkey --name="contributor 3" -v
```

5. The coordinator applies a public beacon. Announce the source before it exists, for example a future Cardano block hash:

```bash
snarkjs zkey beacon spend_0003.zkey spend_final.zkey <beacon-hex> 10 -n="final beacon"
```

6. Anyone verifies the final key against the circuit and the phase 1 file:

```bash
snarkjs zkey verify build/spend.r1cs pot_final.ptau spend_final.zkey
```

7. Export the verification key:

```bash
snarkjs zkey export verificationkey spend_final.zkey spend_vkey.json
```

Each contributor publishes the contribution hash that snarkjs prints. The verify step lists the same hashes.

## 4. After the ceremony

1. Convert each verification key to compressed bytes with `vkToCardano` from `packages/crypto`.
2. Check the converted key against a fresh proof in an Aiken test before you build the validators.
3. Build the validators with the three keys as parameters.
4. Write the manifest.

## 5. Manifest format

`artifacts/manifest.json` pins everything a user or auditor must be able to check.

```json
{
  "version": "m0",
  "date": "2026-10-06",
  "phase1": { "file": "pot_final.ptau", "sha256": "..." },
  "circuits": {
    "spend": {
      "r1cs_sha256": "...",
      "wasm_sha256": "...",
      "zkey_sha256": "...",
      "vkey_sha256": "...",
      "contributions": ["..."],
      "beacon": "..."
    },
    "insert": {},
    "ragequit": {}
  },
  "scripts": {
    "pool": "script hash",
    "deposit": "script hash",
    "config": "script hash",
    "asp": "script hash",
    "nft": "policy id"
  },
  "toolchain": { "circom": "...", "snarkjs": "...", "aiken": "..." }
}
```

The SDK checks the circuit files it downloads against this manifest before it proves.
