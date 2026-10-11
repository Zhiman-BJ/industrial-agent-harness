# Desktop adapter instructions

The repository-root [AGENTS.md](../../AGENTS.md) owns the architecture contract and supersedes this file. This file adds the operational rules for `apps/desktop` (Electron + React 19 + Vite adapter). Commands assume the repo root unless a `--filter` is shown.

## Commands

- `pnpm dev` — Vite dev server + Electron window.
- `pnpm --filter @industrial-agent-harness/desktop build` — build before selftests or screenshots: they load the built `dist/`, so testing an unbuilt tree verifies stale code.
- `pnpm --filter @industrial-agent-harness/desktop test` — package tests.
- `test:ui`, `test:messages`, `test:logs`, `test:documents` (same filter) — named real-renderer regression flows; update them when entry points change.
- Electron selftests are `electron/*-selftest.cjs`; `INDUSTRIAL_UI_SCREENSHOTS=<dir>` with the matching selftest writes PNG evidence.
- `pnpm --filter @industrial-agent-harness/desktop setup:layout` — creates the machine-local KLayout Python venv (gitignored) required for GDS raster tabs.

## Adapter boundaries

- Desktop is one adapter over shared Harness packages: never import `apps/cli/`, and never run industrial executables from the app — industrial Actions go through the shared Runtime boundary only.
- Renderer access stays behind the narrow preload/main-process IPC; mutating actions require explicit permissions and stay bound to the selected project.
- Keep Electron-specific code (main process, preload, viewer host) here; task, session and broker orchestration belongs below the adapters.
- Viewer UI state is display-only: it never updates verification or DomainState.

## UI conventions

- Stay on the `--ia-*` design-token system with light and dark themes; rules and layout contracts are in [DESIGN.md](DESIGN.md).
- User-visible strings go through `t(...)` backed by `i18n.config.json`; do not hardcode translatable text. Keep README and README.zh-CN entries aligned when behavior changes.
- A change that alters visible UI behavior updates its selftest (or `test:ui` coverage) in the same change.
- No hardcoded domain/stage selectors in the generic composer; the project domain is chosen at project creation and enforced by the Broker.
