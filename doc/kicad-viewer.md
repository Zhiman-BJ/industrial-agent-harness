# KiCad Viewer V1

PCB projects reuse the file tree → Artifact ID → Viewer Registry → isolated canvas path used by the Godot Viewer. Opening a `.kicad_pcb` or `.kicad_sch` file displays the local KiCanvas viewer. No KiCad installation, export step, or network connection is required. The existing PCB domain remains `pcb`; this does not introduce another domain or agent tool.

## Use

The original [LED example](../examples/pcb-led/README.md) supplies a self-contained board and schematic that can be bound as a normal PCB project. Both files are also rendered by the macOS desktop selftest.

The shared workspace toolbar provides zoom out/in, Fit and fullscreen. The canvas supports ordinary wheel and Ctrl+wheel trackpad pinch; middle/right drag pans, and Shift+wheel retains upstream pan. Fit defaults to the design content, excluding the drawing sheet/grid; Whole page restores the complete sheet. The pinned label painter includes the origin in its bounds, so fitting uses a conservative text envelope at each label anchor without changing CAD rendering.

Create or select a project with the PCB domain, open the workspace and file tree, then select a board or schematic. The board viewer provides pan/zoom, front/back view, layer visibility, footprints, nets, and selected-object properties. Schematics provide pan/zoom, symbols, and properties. Referenced schematic sheets in the same document directory or its subdirectories are included and accessible from KiCanvas's project panel.

This is a read-only 2D preview. Editing, routing, DRC/ERC, manufacturing exports, 3D models, and connection to a running native KiCad editor are outside this integration. `.kicad_pro` settings and legacy `.brd`/`.sch` files retain ordinary file preview. KiCad 6+ S-expression inputs are recognized; KiCanvas is an alpha parser, so recognition does not guarantee all features of later KiCad formats render correctly. Custom fonts and embedded 3D assets are not rendered.

## Boundaries

The Electron host registers the selected project file and verifies its SHA-256 before opening. `KiCadRuntimeManager` discovers only explicitly referenced child sheets, records their hashes, and exposes a single session under `app://kicad/<token>/`. Every request rechecks all source paths and hashes and returns the previously verified bytes. A changed/deleted source or replaced symlink requires reopening. Opening another KiCad view or changing the active project invalidates the previous session.

Sources are limited to 16 MiB per file, 64 MiB total, 32 files, 128 S-expression levels, and 500,000 tokens per file. Missing, cyclic, absolute, variable-based, or escaping sheet references fail closed. Companion paths must remain in the selected document's directory tree and resolve inside the active project. Files outside this boundary should be opened individually or reorganized by the user.

The iframe uses a separate origin, `allow-scripts allow-same-origin`, no Node/preload API, and a local-only CSP. KiCad text is loaded into `kicanvas-source` using `textContent`; project data is never injected into HTML or scripts. The host serves only fixed runtime assets, a bounded source manifest, and numbered sources. No arbitrary files, external fonts, remote services, or user scripts are loaded. The versioned bridge reports readiness only after the actual viewer emits its load event. The parent checks the iframe source, origin, and channel; errors and a 30-second timeout produce a failed view, and unload the iframe.

KiCanvas view state never updates verification or engineering acceptance. File registration continues to use the existing observed-artifact path; source hashes are observations, not DRC/ERC evidence. No industrial executable is launched, so no new Domain Runtime bypass is introduced.

## Provenance and rebuild

KiCanvas is built from [theacodes/kicanvas](https://github.com/theacodes/kicanvas/tree/b031159eb74aaa7eef2b026fd85d35bc05ff2095), commit `b031159eb74aaa7eef2b026fd85d35bc05ff2095`, with esbuild `0.27.1`. The adapter follows the upstream [embedding interface](https://kicanvas.org/embedding/) and verifies event behavior against the pinned source. The build includes the embed element, both viewer applications, and the upstream SVG toolbar icons. It omits the upstream Google Fonts injection and supplies a local Material Symbols font plus system UI fonts; CAD parsing/rendering is unchanged.

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
