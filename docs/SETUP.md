# zBase Cardano: Setup

| Field | Value |
|---|---|
| Status | v1.0, 2026-10-06 |
| For | Anyone who builds or tests this project |

Follow these steps on a fresh machine. Each step ends with a check.

## 1. Toolchain

| Tool | Version | Why this version |
|---|---|---|
| Node.js | 22 or later | `@x402/cardano` and the Mesh SDK target modern Node |
| Aiken | 1.1.24 or later | The latest release. It knows the protocol version 11 cost models |
| circom | 2.2.x, through the `circom2` npm package 0.2.23 | No native install needed |
| snarkjs | 0.7.6 | Supports Groth16 on curve `bls12-381` |
| `poseidon-bls12381-circom` | 1.0.0 | The Poseidon255 circuits |
| `poseidon-bls12381` | 1.0.2 | The matching TypeScript library |
| `@noble/curves` | 2.4.0 | Point compression to the format Cardano expects |
| Mesh SDK (`@meshsdk/core`) | 1.9.x | Transaction building |
| `@x402/cardano` | 2.28.x | The x402 scheme for Cardano |
| `aiken-lang/merkle-patricia-forestry` | 2.1.0 | The nullifier set |

Section 4 lists which stdlib version to pin, and how these versions were checked.

### Steps

1. Install Node 22 or later. Check with `node --version`.
2. Install `aikup`, the Aiken version manager, then run it. `aikup` alone installs the latest Aiken.

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://install.aiken-lang.org | sh
aikup
```

   Check with `aiken --version`. It must print 1.1.24 or later. To pin an exact version, see `aikup --help`.

3. Install the JavaScript tools inside the repo, not globally:

```bash
npm install --save-dev circom2@0.2.23 snarkjs@0.7.6
```

4. Check the circuit compiler. It must print a 2.2.x version:

```bash
npx circom2 --version
```

5. Check snarkjs. It must print 0.7.6:

```bash
npx snarkjs --version
```

## 2. Accounts and keys

| Item | Needed for | Note |
|---|---|---|
| Blockfrost project for Cardano mainnet | Chain data, evaluation, submit | Keep the project ID in `.env`, never in git |
| Operator, relayer, admin, ASP, and test wallets | The runbook | See [RUNBOOK-M0.md](./RUNBOOK-M0.md) section 1 |

CAUTION: `.env` files, seed phrases, signing keys, and proving keys must never enter git. The `.gitignore` already blocks `.env`, `*.zkey`, and `*.ptau`.

## 3. AI coding agents

This repo works with AI coding agents. [AGENTS.md](../AGENTS.md) holds the rules they must follow.

For Claude Code, install the Cardano Dev Skills plugin. It bundles current Aiken, Mesh, x402, and Masumi documentation.

1. Add the marketplace:

```text
/plugin marketplace add cardano-foundation/cardano-dev-skills
```

2. Install the plugin:

```text
/plugin install cardano-dev-skills@cardano-dev-skills
```

3. Wire it into this project:

```text
/cardano-context
```

Run the first two commands in that order. For other agents, clone the skills repo and link its `skills` folder as its README describes.

## 4. Verified combinations

These versions were run together on 2026-10-06, on macOS arm64 with Node 24.10.0.

| Combination | Result |
|---|---|
| `circom2` 0.2.23 (circom 2.2.3) with `--prime bls12381`, snarkjs 0.7.6, `poseidon-bls12381-circom` 1.0.0 | Circuits compile, witnesses check, and hashes match `poseidon-bls12381` 1.0.2 |
| snarkjs 0.7.6 Groth16 on `bls12-381`, `@noble/curves` 2.4.0, Aiken 1.1.24 | A converted proof verifies with the Plutus builtins |
| Aiken 1.1.24, `aiken-lang/merkle-patricia-forestry` 2.1.0, stdlib v2.2.1, v3.1.0, or v4.0.0 | Compiles, and a trie insert test passes |

Pin stdlib v4.0.0 for this project.

Things that cost time in those runs:

- Compile circuits with `--O2`. The default level makes each hash about 2.6 times larger.
- `circom2` needs a real `node_modules` folder in the working directory. A symlink fails.
- Import `@noble/curves/bls12-381.js`, with the `.js` suffix.
- A script that calls snarkjs must end with `process.exit`, or it hangs.
- The trie library is imported as `aiken/merkle_patricia_forestry`.
- Aiken caches packages under the home directory. Set `HOME` to a project folder if you need an isolated build.

See [research/2026-10-06-measurements.md](./research/2026-10-06-measurements.md) and [research/spikes/](./research/spikes/) for the full results.
