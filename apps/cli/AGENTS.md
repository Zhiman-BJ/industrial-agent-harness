# Headless CLI adapter instructions

The repository-root [AGENTS.md](../../AGENTS.md) owns the architecture contract and supersedes this file. This file adds the operational rules for `apps/cli`, the bench-facing headless adapter. Run commands from the repo root.

## Commands

- `pnpm --filter @industrial-agent-harness/cli test` — CLI package tests.
- `node apps/cli/src/main.cjs run --project-dir <dir> --domain <domain> --task '...' [--scope-only]` — one task; JSONL events per line. `--scope-only` needs no model key and emits the L0–L3 scope trace.
- `node apps/cli/src/main.cjs bench --suite examples/bench/scope-smoke.json --output-dir <fresh-dir>` — sequential suite runner writing per-scenario JSONL evidence plus `summary.json`; non-zero exit on assertion mismatch. Always use a fresh output directory.
- `node apps/cli/src/main.cjs chat --project-dir <dir> --domain <domain> ...` — interactive REPL.
- Error paths print a `{"type":"error",...}` JSON line and exit 1.

## Adapter boundaries

- The CLI must run without Electron, browser globals, or Viewer UI dependencies (the contract checker fails CI on such imports) so bench runners can exercise domain tasks headlessly.
- Broker, Kimi integration and the capability registry are shared with Desktop below the adapter layer; never duplicate their behavior here.
- Apply the same effective resource/MCP policy as Desktop before Broker resolution — the CLI is not a policy bypass.
