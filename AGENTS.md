# Repository instructions

This repository is an early architecture scaffold for Industrial Agent Harness.

## Boundaries

- Keep the Electron application, Kimi adapter, domain skills, domain runtime, domain MCP, and shared contracts in their respective workspaces.
- Use `@moonshot-ai/kimi-agent-sdk` at the exact declared version as the coding agent. Commit the pnpm lockfile. Do not implement a second agent loop or patch/fork the SDK unless a verified integration gap requires an explicit architecture decision.
- Keep `domain-runtime` independent of Electron, Kimi, and MCP. The MCP package exposes domain capabilities; it does not own execution truth.
- Make skill and MCP disclosure progressive. Return a compact index first, fetch detailed instructions and schemas on demand, and register only relevant tools for a task.
- Keep project paths, permissions, and tool execution behind a narrow Electron main/preload boundary. Do not give the renderer unrestricted Node or filesystem access.
- Record concrete inputs, run identity, artifacts, diagnostics, and acceptance evidence. Never present process exit or a demo fixture as verified domain success.

## Changes

- Update the relevant package README when changing a module boundary or public contract.
- Add meaningful contract or integration tests when behavior is implemented; do not write tests that merely mirror declarations.
- Do not claim Linux, macOS, or Windows support until the corresponding build and runtime flow has been exercised.
- Treat the existing demo and EDA Harness as reference implementations; copy code only with deliberate provenance and license review.
