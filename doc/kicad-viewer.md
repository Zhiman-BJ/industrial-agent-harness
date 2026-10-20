# KiCad Viewer V1

PCB projects reuse the file tree → Artifact ID → Viewer Registry → isolated canvas path used by the Godot Viewer. Opening a `.kicad_pcb` or `.kicad_sch` file displays the local KiCanvas viewer. Local preview needs no KiCad installation, export step or network connection. Optional acquisition of missing official STEP models requires an explicit user action and runs in the host, not in the iframe. The existing PCB domain remains `pcb`; this does not introduce another domain or agent tool.

## Use

The original [LED example](../examples/pcb-led/README.md) supplies a self-contained board and schematic that can be bound as a normal PCB project. Both files are also rendered by the macOS desktop selftest.

The shared workspace toolbar provides zoom out/in, Fit and fullscreen. The canvas supports ordinary wheel and Ctrl+wheel trackpad pinch; middle/right drag pans, and Shift+wheel retains upstream pan. Fit defaults to the design content, excluding the drawing sheet/grid; Whole page restores the complete sheet. The pinned label painter includes the origin in its bounds, so fitting uses a conservative text envelope at each label anchor without changing CAD rendering.

Create or select a project with the PCB domain, open the workspace and file tree, then select a board or schematic. The board viewer provides pan/zoom, front/back view, layer visibility, footprints, nets, and selected-object properties. Schematics provide pan/zoom, symbols, and properties. Referenced schematic sheets in the same document directory or its subdirectories are included and accessible from KiCanvas's project panel.

This is a read-only preview. PCB files also offer [3D geometry](pcb-3d-viewer.md) derived from the same pinned KiCanvas painter. Project-local STEP and supported static KiCad legacy WRL component bodies are included in the 3D path, with source placement, picking and visibility controls. Editing, routing, DRC/ERC, manufacturing exports and connection to a running native KiCad editor remain outside this integration. `.kicad_pro` settings, symbol/footprint libraries, Gerber/drill and limited 3D source previews are handled by the separate [engineering-file Viewer](engineering-file-viewers.md); legacy `.brd`/`.sch` files retain ordinary file preview. KiCad 6+ S-expression inputs are recognized; KiCanvas is an alpha parser, so recognition does not guarantee all features of later KiCad formats render correctly. Custom fonts and embedded 3D assets are not rendered.

## Boundaries

The Electron host registers the selected project file and verifies its SHA-256 before opening. `KiCadRuntimeManager` discovers only explicitly referenced child sheets, records their hashes, and exposes a token-scoped session under `app://kicad/<token>/`. Every request rechecks all source paths and hashes and returns the previously verified bytes. A changed/deleted source or replaced symlink requires reopening. Retained KiCad tabs have independent session tokens: opening B does not expire A, so A–B–A can continue model preparation. Closing one view releases only its token; switching the active project or exiting releases all sessions. At most 16 sessions and 256 MiB of combined source/model snapshots are retained; exceeding either bound rejects the new open while preserving existing tabs.

Sources are limited to 16 MiB per file, 64 MiB total, 32 files, 128 S-expression levels, and 1,250,000 tokens per file. Missing, cyclic, absolute, variable-based, or escaping sheet references fail closed. Companion paths must remain in the selected document's directory tree and resolve inside the active project. Files outside this boundary should be opened individually or reorganized by the user.

The iframe uses a separate origin, `allow-scripts allow-same-origin`, no Node/preload API, and a local-only CSP. KiCad text is loaded into `kicanvas-source` using `textContent`; project data is never injected into HTML or scripts. The host serves only fixed runtime assets, bounded source/model manifests, numbered sources and exact approved model resources. No arbitrary files, external fonts, remote services, or user scripts are loaded. The versioned bridge reports readiness only after the actual viewer emits its load event. The parent checks the iframe source, origin, and channel; errors and a 30-second timeout produce a failed view, and unload the iframe.

KiCanvas view state never updates verification or engineering acceptance. File registration continues to use the existing observed-artifact path; source hashes are observations, not DRC/ERC evidence. No industrial executable is launched, so no new Domain Runtime bypass is introduced.

## Official models and shared resource management

Local model files take priority. Project-relative paths and `${KIPRJMOD}` remain
inside the active project; `${KICADn_3DMODEL_DIR}` and `${KISYS3DMOD}` map to the
project's `3dmodels/` directory for offline packaging, not to arbitrary global
library paths. Existing local WRL files retain their limited static-format
support. A WRL reference is never silently replaced by a similarly named STEP.

This branch adds an explicit missing-model download action. Opening a file or
planning missing resources does not download them. The external PCB Pack owner
maintains a fixed official KiCad `10.0.7` STEP catalog at
`8d4070daa0fa3f7a7f3c176f4ca7bffc4df392be`: 7,252 entries in 105 families,
with raw SHA-256, byte sizes, provenance and license metadata. The shared Pack
Manager's generic `dataLibraries` acquires only the declared resources required
by the current project, verifies them and manages cancellation, budgets and
reusable cache. This is separate from native application installation; bulk
prefetch of the complete library is not implemented by this change.

The host grants exact source-reference/root/path/hash/size bindings against the
current project and source snapshot. It never exposes an arbitrary cache root
or URL chosen by the renderer. Model bytes still use the restricted local
session resource channel: `connect-src 'self'`, fixed local workers and WASM,
without renderer access to external networks or JavaScript `unsafe-eval`.
Closed or changed sessions cannot acquire a late model into another view.
Downloading resources does not rewrite the board, change DomainState or produce
an engineering verification result. See [PCB 3D](pcb-3d-viewer.md) for parsing and
GPU limits and [the QA matrix](qa-runbook/viewers-results.md) for pending evidence.

## Provenance and rebuild

KiCanvas is built from [theacodes/kicanvas](https://github.com/theacodes/kicanvas/tree/b031159eb74aaa7eef2b026fd85d35bc05ff2095), commit `b031159eb74aaa7eef2b026fd85d35bc05ff2095`, with esbuild `0.27.1`. The adapter follows the upstream [embedding interface](https://kicanvas.org/embedding/) and verifies event behavior against the pinned source. The build includes the embed element, both viewer applications, and the upstream SVG toolbar icons. It omits the upstream Google Fonts injection and supplies a local Material Symbols font plus system UI fonts; CAD parsing/rendering is unchanged. The local bundle additionally exports its painter, layer set and null renderer for read-only geometry capture.

Runtime fingerprints and upstream/third-party copyright and license notices are included in `packages/viewer-builtin/src/kicad/vendor/`. Fixture provenance is recorded separately under `fixtures/kicad/`. Both runtime and font are committed, and the application does not download them at startup.

To rebuild, check out the pinned upstream commit, install its dependencies with esbuild `0.27.1`, and run:

```sh
node packages/viewer-builtin/scripts/build-kicanvas.cjs /absolute/path/to/kicanvas
```

The script requires an unmodified tracked checkout, rebuilds the bundle/notices, and updates the asset manifest while preserving the committed local font.

## Validation

```sh
pnpm --filter @industrial-agent-harness/viewer-builtin test
pnpm --filter @industrial-agent-harness/domain-skills test
pnpm test:architecture
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:kicad
```

On 2026-09-28 the runtime tests, architecture gate, skill tests, TypeScript/Vite build, and macOS Electron integration passed. The desktop test creates an isolated temporary PCB project, selects real KiCad geometry fixtures through the production file tree/IPC/Registry path, checks board/schematic/multi-sheet canvas loading, native camera zoom/Fit, cursor anchoring for wheel/pinch, fullscreen and layer toggles, captures screenshots, rejects a malformed source and changed child sheet, and blocks/checks all network requests. It does not modify the user's projects or model configuration. Linux/Windows packaged flows remain unverified.

The 2026-09-28 record above predates PCB component bodies and official model acquisition. It does not qualify this branch’s new download path, STEP/WRL assembly rendering or GPU behavior; current desktop/GPU acceptance remains pending.
