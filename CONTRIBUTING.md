# Contributing

Read [AGENTS.md](AGENTS.md) first. Its hard rules apply to every change.

## Workflow

1. Pick a task from [docs/PLAN-M0.md](docs/PLAN-M0.md).
2. Create a branch named after the work package, for example `wp3-settle-rules`.
3. Write the failing tests first, with the IDs from [docs/TEST-PLAN.md](docs/TEST-PLAN.md).
4. Write the code until the tests pass.
5. Open a pull request. Fill in the checklist below.

## Pull request checklist

- [ ] The change matches the Spec, or the Spec is updated in this pull request.
- [ ] Every new rule has a passing test and a failing test.
- [ ] `npm test` passes.
- [ ] `aiken check` passes, if `contracts/` changed.
- [ ] No secret, key, or large generated file is in the diff.
- [ ] Measured costs are recorded, if a validator or circuit changed.
- [ ] The docs that describe the changed behavior are updated.

## Commit messages

Use the form `type: short summary`, for example `feat: add settle rules S1 to S7`.
Common types are `feat`, `fix`, `test`, `docs`, and `chore`.

## Changing a circuit or a validator

A change after the setup ceremony or after deploy means new keys, new script hashes, and a new pool.
Say so in the pull request title, and update `artifacts/manifest.json` in the same change.

## Security issues

Do not open a public issue for a bug that could put funds at risk.
Tell the owner directly, and pause deposits if a deployed pool is affected.
