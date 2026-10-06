# Artifacts

Small public files that code and tests on every machine must agree on.

| File | What it is |
|---|---|
| `public-signals.json` | The order of the public inputs of each circuit. `npm run build:circuits` writes it, and a circuit test guards it. |
| `dev/<circuit>_vkey.json` | The development verification keys, in snarkjs format. |
| `dev/manifest.json` | The hashes of the development circuit files and keys. |

The development proving keys are large and stay out of git. They live in `circuits/build/dev/` after `npm run setup:dev`.
Each setup run makes different keys. So the keys in `dev/` belong to one setup run, and the proof fixtures under `contracts/` were made with it.

If you run a new setup, your proving keys no longer match these files. Then copy your new `*_vkey.json` and `manifest.json` here and rebuild the proof fixtures.

CAUTION: development keys are for tests only and must never guard funds.
