# Contributing

This document is for human contributors and reviewers. Coding agents follow
[AGENTS.md](AGENTS.md) plus the package-level `AGENTS.md` files (the closest
file to the one being edited wins). The rules below overlap those files and add
the collaboration workflow.

## Repository roles

This repository is the Harness: canonical industrial contracts, the shared task
API, and the Desktop/CLI adapters. Domain implementations (Skills,
StateProviders, Verifiers, runtimes, images) are maintained in
[industrial-domain-packs](https://github.com/Zhiman-BJ/industrial-domain-packs)
and consumed here as immutable pinned releases. Architecture contract
IH-ARCH-001 (`doc/architecture-contract.md`) is the accepted ownership boundary;
read it before changing module boundaries.

## Setup

- Node.js ≥ 24 and pnpm (the version CI pins, currently 11.1.3).
- `pnpm install --frozen-lockfile`

## Everyday commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Desktop dev (Vite + Electron) |
| `pnpm build && pnpm start` | Run the built desktop app |
| `pnpm format` / `pnpm format:check` | Prettier write / verify |
| `pnpm lint` | ESLint static analysis (errors gate CI) |
| `pnpm test` | Every workspace package's test suite |
| `pnpm test:architecture` | Architecture boundary gate (CI-enforced) |
| `pnpm test:architecture-contract` | Cross-repo contract and policy-hash gate |
| `pnpm test:ci -- <layer>` | CI layer: `portable`, `benchmark`, `transport`, `native*` |

Package-specific commands and constraints live in each package's README and
`AGENTS.md` where present (`apps/desktop`, `packages/agent-kimi`,
`packages/viewer-builtin` today).

## Pull requests

- **Conventional Commits**: `feat|fix|docs|chore|test|refactor(scope): summary`.
- **Keep pull requests reviewable.** Around 1,200 changed lines should be
  split; above roughly 2,000 lines a PR must be split or its description must
  justify why it cannot be. Migrations that necessarily touch many files say so
  up front.
- State verification evidence per the PR template: which real-path tests ran
  and which platforms were actually exercised. Fixtures, mocks and exit codes
  are not engineering acceptance.
- Architecture exceptions only shrink. Never widen or regenerate
  `architecture/policy.json` exceptions to land a feature; a violation is
  resolved in its owning layer.
- Area gating is automatic: documentation-only PRs skip execution layers
  (`scripts/ci-areas.cjs` decides; `skills/` content is runtime resource, not
  documentation), everything else runs the shared portable matrix.

## Protected machinery

`AGENTS.md`, `architecture/`, `scripts/check-architecture-contract.cjs`,
`scripts/fetch-architecture-candidate.cjs`, their tests, the contract workflow
and `.github/CODEOWNERS` are hash-locked in `architecture/policy.json`. Changing
them requires a separate, explicitly owner-approved architecture revision with
rationale, migration and positive/negative evidence — never bundle such a
change into a feature PR.

## Agent-assisted work

- AI agents must not modify the protected machinery above, and must not claim
  support for a platform that was not actually exercised.
- Every verification claim in a PR description should name the command that
  produced it.
