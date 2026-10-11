# Kimi Code integration instructions

The repository-root [AGENTS.md](../../AGENTS.md) owns the architecture contract and supersedes this file. This package is the only home for Kimi-specific integration; the rules below protect the pinned upstream kernel.

## Non-negotiable

- Use the exact declared `@moonshot-ai/kimi-code` version (currently 2.1.1) with the committed lockfile. `KIMI_EXECUTABLE` may override with a compatible entry; a version mismatch fails startup, it never warns.
- Never recreate, patch, or fork the upstream agent loop, session persistence, compaction, subagent runtime, skill runtime, or tool loop. A documented, accepted architecture decision must precede any integration-gap workaround.
- Keep all Kimi-specific code inside this package. Core modules (`harness-core`, `contracts`, `domain-runtime`, `capability-broker`, `viewer-core`) must not import it — the contract checker fails CI on that.
- Harness owns approval policy, Scope and the Industrial Context; the kernel owns its conversation, compaction and native identity. Trust the pinned kernel's compaction quality (PD-048): wrapper tests check event/context and restore compatibility, not summary quality.

## Working rules

- `KimiSession` preserves the shared UI/CLI event interface: map new native capabilities (e.g. `subagent.*`) onto it instead of adding parallel channels.
- The transport boundaries are deliberate: 16 KiB harness tool output, 8 KiB Industrial Context, and the 3,660,000 ms `toolTimeoutMs` watchdog on the internal `harness_adapter` MCP entry only. Do not widen them without updating [README.md](README.md) with the reason.
- A compatibility claim needs a real-path test against the pinned runtime with a controlled local provider; fixture replay is not evidence.
