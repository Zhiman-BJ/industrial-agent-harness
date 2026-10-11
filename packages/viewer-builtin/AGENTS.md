# Built-in viewer instructions

The repository-root [AGENTS.md](../../AGENTS.md) owns the authoritative Viewer integration contract; read its "Viewer integration contract" section before any change here. This file is the package-local summary.

## Boundaries

- Viewers are read-only display. A viewer result never updates verification, DomainState, or source files; zoom, pan, selection and fullscreen are temporary view state.
- Selection and navigation go through Viewer Core/Registry: implement `ViewNavigation` in `src/navigation.tsx` (zoom out/in, Fit, readiness, scale indicator); hosts mount only the viewer matching the current artifact ID.
- Keep this package independent of Kimi, MCP, Electron and concrete domains; host-specific wiring stays in `apps/desktop`.
- Preserve bounded read-only file access, source/companion hash checks, parser limits, sandboxing and explicit loading/error states for every new format.

## Integration checklist (same change as the viewer code)

- Canvas wheel and trackpad pinch zoom; zoom disabled while loading or after failure; stale controllers, listeners and runtime sessions removed on file/project switch or unmount; fullscreen retains the mounted viewer and its state.
- Verify the real Project file tree → Registry → rendered Viewer path before claiming integration; report only platforms actually exercised.
- Update the repository-root `README.md` "Viewers" section and `README.zh-CN.md` "已接入的 Viewer" (supported inputs, features, dependencies, limitations) plus the relevant `doc/` pages; keep both languages aligned.

## Commands

- `pnpm --filter @industrial-agent-harness/viewer-builtin test` — rendering and file-access boundary tests.
