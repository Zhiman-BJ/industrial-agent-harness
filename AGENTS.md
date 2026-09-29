# Industrial Agent Harness repository instructions

Read `doc/README.md` before changing architecture or module boundaries. The repository is a working Workbench MVP, not yet Industrial Harness Core. Documentation marked as proposed is not implemented behavior.

## Current milestone: Industrial Core Vertical Slice

The next milestone is one real, persistent Project → StateProvider → DomainState → Broker → Kimi → scoped Tool → Domain Runtime → Action → Artifact → Verifier → new DomainState → Checkpoint path shared by Desktop and CLI. Until its integration test passes, prioritize this path over new UX, Viewers, capability demos, domains, trajectory replay UI, or a generic multi-agent adapter. The current milestone and bounded MVP shortcuts are recorded in `doc/prototype-register.json`.

## Non-negotiable invariants

- User prompts express intent. Engineering facts require a DomainState source, artifact, verification result, or explicitly attributed user input. Do not turn a keyword guess into a trusted stage or metric.
- Every industrial Action enters Domain Runtime. Desktop, CLI, MCP, and agent adapters must not directly run industrial executables. A mutating attempt records Run/Action identity, real inputs, diagnostics, an explicit artifact set (possibly empty on failure), and a VerificationResult. Process exit code alone never means engineering acceptance.
- `packages/contracts` owns the canonical industrial Artifact, State, Run, Action, Verification, Tool, and Checkpoint contracts. Other layers may define display views but must not create competing engineering facts.
- `harness-core`, `capability-broker`, `agent-kimi`, `viewer-core`, and `contracts` must not gain concrete domain IDs. Kimi consumes ToolDescriptors, and the execution boundary rechecks the Broker allowlist. MCP disclosure alone is not permission.
- Viewer selection belongs in Viewer Core/Registry and remains read-only display. A Viewer result cannot update verification or DomainState.
- The existing MVP shortcuts listed in `doc/prototype-register.json` are frozen exceptions, not patterns to copy. If a lower-level abstraction is needed, implement it below the adapters and remove its old bypass path.

## Definition of Done

Mark a core module implemented only when production code has a real consumer, a real-path integration test, tested failure behavior, a removed or registered bypass, and documentation matching exercised behavior. `pnpm test:architecture` is a CI gate; it does not replace the vertical-slice E2E. See `doc/04-definition-of-done-and-architecture-tests.md`.

## Architecture boundaries

- Kimi Code is the selected agent kernel for the first stage. Use the exact declared `@moonshot-ai/kimi-agent-sdk` version and committed pnpm lockfile. Keep Kimi-specific code in `packages/agent-kimi` or a future Kimi integration workspace.
- Do not recreate Kimi's agent loop, session persistence, compaction, subagent runtime, skill runtime, or tool loop. Do not modify or fork upstream Kimi Code without a documented, verified integration gap and an explicit architecture decision.
- Keep industrial state, artifacts, actions, verification, checkpoints, trajectories, capability resolution, and policy in Harness-owned modules. Core modules must not import Kimi Code or a concrete domain.
- Do not introduce a lowest-common-denominator adapter for multiple agent products during the Kimi-focused first stage. Keep the industrial contracts independent so another integration remains possible later.
- Domain-specific behavior belongs in Domain Packs, configuration, or plugins. Do not hardcode Chip, PCB, or another domain in the broker or core.
- Distinguish Tool, Bridge, Viewer, and Verifier. A Tool performs an action; a Bridge connects to software; a Viewer presents state or artifacts; a Verifier evaluates results.
- Keep Viewer Core independent of Kimi, MCP, Electron, and concrete domains. Built-in viewers consume registered artifacts through a bounded read-only interface; UI view state and display caches never become execution or verification facts.
- Offer full in-app viewing only for formats whose parser, performance, license, and target-platform behavior have been verified. For complex CAD/Godot workspaces, show key artifacts without recreating the full editor. External app launch uses a separate authorized path.

## Viewer integration contract

Every new or extended Viewer, including domain-independent document previews, must follow the existing Viewer behavior documented in `doc/product-decisions.md` (PD-003, PD-011, and PD-015), `doc/viewer-layer.md`, and `packages/viewer-builtin/README.md`.

- Register selection through Viewer Core/Registry. Open supported files from the active Project file tree and reuse the shared workspace canvas and toolbar.
- Implement the shared `ViewNavigation` interface in `packages/viewer-builtin/src/navigation.tsx`: zoom out, zoom in, Fit, readiness, and an appropriate scale indicator. Support canvas wheel and trackpad pinch zoom. Fit restores the appropriate content framing; use time-range zoom for waveforms and preview magnification for Godot without changing its scene camera or playback state.
- Reuse workspace fullscreen and exit controls, including Esc. Keep Viewer controls available, retain the mounted Viewer and its view/runtime state across fullscreen changes, and restore the workspace layout on exit.
- Disable zoom while loading or after failure. Remove stale navigation controllers, listeners, and runtime sessions when switching files/projects or unmounting. Keep zoom, pan, selection, and fullscreen as temporary display state; do not modify source files, DomainState, or verification results.
- Preserve the existing bounded read-only file access, source/companion hash checks, parser limits, sandboxing, provenance, and explicit loading/error states. Declare required dependencies, supported formats, and actual platform availability.
- Before claiming integration, verify the real Project file tree → Registry → rendered Viewer path, toolbar zoom, wheel/pinch, Fit, fullscreen entry/exit, state retention, and relevant failure/file-boundary behavior. Follow the existing Viewer integration/selftests; report only platforms actually exercised.
- In the same change, add or update the repository-root `README.md` section “已接入的 Viewer” with the Viewer, supported inputs, viewing features, dependencies, limitations, and a link to its documentation. Update the relevant package README and `doc/` pages whenever their documented behavior changes. An integration is incomplete until its root README entry matches the implemented and verified behavior.

## Capability and disclosure

- Resolve capabilities from the current Domain State and task. Capabilities bind relevant Skill batches, canonical Tool IDs, viewers, verification, dependencies, and conflicts.
- Skill and MCP tool disclosure must be progressive. Expose a compact discovery surface first; load detailed skill content and tool schemas only for a selected capability. Replace stale session scope when the domain stage changes.
- Declare default Skill files in `packages/domain-skills` and default Domain MCP providers in `packages/domain-mcp`. Store only resource ID enablement policy: global defaults and per-project enable/disable overrides, with absence meaning inherit; desktop and CLI must apply the same effective policy before Broker resolution. Do not expose an MCP server with undeclared or out-of-scope tools.
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
- The product file tree contains only files from the active Project. Opening a supported project file selects its Viewer automatically. Keep Viewer fixtures in tests and provenance documentation; do not surface a separate examples menu or fixture list in the product UI.
- Keep Agent process events compact after each prompt. Show only a few live Thinking lines, collapse completed Thinking by default, and present each tool call with its result as one collapsed entry. Leave approval actions visible.
- Present Broker resolution in the Agent flow with the same collapsed Tool Use pattern. Keep Context override, capability details, and debug disclosure trace accessible inside its expanded entry.
- Each project binds one local directory and one domain. Choose a domain when creating the project, and edit it only in that project's detail page. The global Settings menu contains application settings only. Display the project domain as a read-only pill in a new session, and enforce it in the Broker, including requests sent outside the UI. Changing the project domain starts a fresh chat scope.
- Keep the desktop UI and headless CLI as separate adapters over shared Harness packages. The CLI must run without Electron, browser globals, or Viewer UI dependencies so domain tasks can be exercised by bench runners. Shared Broker, Agent, runtime, and domain rules belong below both adapters; do not duplicate their behavior in UI components.
- Do not reintroduce trajectory replay into the MVP. Debug mode shows actual Broker disclosure and agent events, including scope replacement and detailed skill/tool loading.
- Keep package READMEs and `doc/` aligned with implemented boundaries. Mark proposed APIs and milestones as proposals until exercised.
- Record confirmed user-facing product decisions in `doc/product-decisions.md` with a date, status, rationale, and observable behavior. Keep product decisions separate from architecture proposals in `doc/decisions.md`; add a superseding entry when a product decision changes.
- Add meaningful contract and integration tests when behavior is implemented. Verify SDK events, permissions, interruption, recovery, and dynamic disclosure against the pinned version before claiming support.
- Do not claim Linux, macOS, or Windows support until the corresponding packaged runtime flow is exercised.
- Treat the existing demo and EDA Harness as references. Copy code only after checking provenance and license terms.
