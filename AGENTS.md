# Industrial Agent Harness repository instructions

Read `doc/README.md` before changing architecture or module boundaries. The repository is currently a scaffold; documentation marked as proposed is not implemented behavior.

## Architecture boundaries

- Kimi Code is the selected agent kernel for the first stage. Use the exact declared `@moonshot-ai/kimi-agent-sdk` version and committed pnpm lockfile. Keep Kimi-specific code in `packages/agent-kimi` or a future Kimi integration workspace.
- Do not recreate Kimi's agent loop, session persistence, compaction, subagent runtime, skill runtime, or tool loop. Do not modify or fork upstream Kimi Code without a documented, verified integration gap and an explicit architecture decision.
- Keep industrial state, artifacts, actions, verification, checkpoints, trajectories, capability resolution, and policy in Harness-owned modules. Core modules must not import Kimi Code or a concrete domain.
- Do not introduce a lowest-common-denominator adapter for multiple agent products during the Kimi-focused first stage. Keep the industrial contracts independent so another integration remains possible later.
- Domain-specific behavior belongs in Domain Packs, configuration, or plugins. Do not hardcode Chip, PCB, or another domain in the broker or core.
- Distinguish Tool, Bridge, Viewer, and Verifier. A Tool performs an action; a Bridge connects to software; a Viewer presents state or artifacts; a Verifier evaluates results.
- Keep Viewer Core independent of Kimi, MCP, Electron, and concrete domains. Built-in viewers consume registered artifacts through a bounded read-only interface; UI view state and display caches never become execution or verification facts.
- Offer full in-app viewing only for formats whose parser, performance, license, and target-platform behavior have been verified. For complex CAD/Godot workspaces, show key artifacts without recreating the full editor. External app launch uses a separate authorized path.

## Capability and disclosure

- Resolve capabilities from the current Domain State and task. Capabilities bind relevant Skill batches, canonical Tool IDs, viewers, verification, dependencies, and conflicts.
- Skill and MCP tool disclosure must be progressive. Expose a compact discovery surface first; load detailed skill content and tool schemas only for a selected capability. Replace stale session scope when the domain stage changes.
- Keep canonical Tool IDs separate from MCP provider names and transport-specific tool names. Enforce the resulting tool allowlist at the execution boundary, not solely in prompts.
- Make resolver decisions deterministic and testable in V1. Record candidates, selected capabilities, disclosed skills and tools, scope changes, and execution outcomes in a disclosure trace.
- Keep conversation history and compaction under Kimi's control. Harness supplies a bounded, structured Industrial Context.

## Execution and safety

- Keep Electron renderer access behind narrow preload and main-process IPC. Bind calls to the selected project and apply explicit permissions to mutating actions.
- Local services should bind to `127.0.0.1` by default. A failed broker or Domain Pack must not corrupt Kimi configuration or bring down unrelated domains.
- Record actual inputs, run identity, state changes, artifact provenance, diagnostics, and verification evidence. Process success and demo fixtures are not proof of engineering acceptance.
- Bind viewer requests to artifact IDs and explicit project/run/state context. Verify source and companion hashes, limit parsing resources, and prevent untrusted artifact or plugin content from running scripts in the renderer. Rendered or launched does not mean verified.
- Every industrial action must be observable; critical actions require explicit verification. Preserve historical states and avoid silently replacing evidence after inputs change.

## Working in this repository

- The MVP desktop layout is project/chat sidebar | agent chat flow | file workspace. Keep the left and right panels collapsible, put settings at the lower left, and support light and dark themes. The workspace and its file tree start closed. The workspace previews ordinary source files; registered specialized formats activate a Viewer in the file canvas. Do not put hardcoded domain/stage selectors in the generic composer.
- Each project binds one local directory and one domain. Choose a domain when creating the project, and edit it only in that project's detail page. The global Settings menu contains application settings only. Display the project domain as a read-only pill in a new session, and enforce it in the Broker, including requests sent outside the UI. Changing the project domain starts a fresh chat scope.
- Keep the desktop UI and headless CLI as separate adapters over shared Harness packages. The CLI must run without Electron, browser globals, or Viewer UI dependencies so domain tasks can be exercised by bench runners. Shared Broker, Agent, runtime, and domain rules belong below both adapters; do not duplicate their behavior in UI components.
- Do not reintroduce trajectory replay into the MVP. Debug mode shows actual Broker disclosure and agent events, including scope replacement and detailed skill/tool loading.
- Keep package READMEs and `doc/` aligned with implemented boundaries. Mark proposed APIs and milestones as proposals until exercised.
- Record confirmed user-facing product decisions in `doc/product-decisions.md` with a date, status, rationale, and observable behavior. Keep product decisions separate from architecture proposals in `doc/decisions.md`; add a superseding entry when a product decision changes.
- Add meaningful contract and integration tests when behavior is implemented. Verify SDK events, permissions, interruption, recovery, and dynamic disclosure against the pinned version before claiming support.
- Do not claim Linux, macOS, or Windows support until the corresponding packaged runtime flow is exercised.
- Treat the existing demo and EDA Harness as references. Copy code only after checking provenance and license terms.
