# Godot Viewer V1

Godot is registered as a Viewer-only project domain. Opening a Godot Web Export HTML file from the active project displays it in the workspace. The export must have matching `.html`, `.js`, `.wasm`, and `.pck` files in one directory, for example `warehouse.html`, `warehouse.js`, `warehouse.wasm`, and `warehouse.pck`. Use the single-threaded Godot 4 Web export. The project file tree does not launch the Godot editor or import a `.tscn` directly.

## Preparing an export

1. Copy [`harness_viewer_bridge.gd`](../packages/viewer-builtin/src/godot/harness_viewer_bridge.gd) into the Godot project and register it as an Autoload named `HarnessViewerBridge`.
2. Export the project for Web with one thread and keep the output files together inside the Industrial Harness project directory.
3. Open the export HTML in the file tree. The Viewer waits for the autoload handshake before enabling controls.

The top bar shows the current scene and provides Play, Pause, Stop, Step, and Camera selection. The left pane shows the bounded scene tree (eight levels, up to 100 children per node). Selecting a node requests a bounded inspector snapshot. The canvas renders Godot's own Web runtime. The bottom bar exposes Collision, NavMesh, and Physics overlay slots. They are disabled in V1 because Godot's built-in debug hints do not take effect when changed during a running game; a runtime-specific overlay provider is needed to make those switches truthful.

Stop reloads the current scene. Step resumes until the next rendered frame, then pauses; it is not a deterministic physics tick or replay. Scene tree and inspection are display state and do not create engineering facts. Godot project editing stays in Godot.

## Boundary

The Electron main process recognizes only complete Web exports, hashes the HTML and companion files, and serves the selected export through a session-scoped `app://godot` URL. Only files with the export's basename and approved extensions are served. Changes after opening are rejected. The iframe is on a separate origin, is sandboxed, and communicates through a versioned `postMessage` channel. `bridge.js` inside the iframe connects that channel to the autoload through Godot `JavaScriptBridge`. The Viewer Bridge has no MCP dependency and never calls industrial tools or Domain Runtime.

The parent validates the iframe source, origin, and channel. The in-frame bridge accepts commands only from its parent frame. Export code still runs as project-provided code inside the isolated iframe, so use trusted exports. Multi-threaded Web exports and custom export templates that require additional files or remote services are outside V1.

An export that does not complete the bridge handshake within 30 seconds reports an error and unloads the iframe. Stop clears the old inspector and waits for the replacement scene to become ready before re-enabling controls, following Godot's [deferred scene replacement](https://docs.godotengine.org/en/4.6/classes/class_scenetree.html#class-scenetree-method-change-scene-to-packed) behavior.

## Validation

`pnpm --filter @industrial-agent-harness/viewer-builtin test` exercises complete/incomplete export recognition, session file boundaries, bridge injection, companion changes, and session closing. The desktop TypeScript and Vite build checks component wiring.

The original [Viewer Playground](../examples/godot-viewer/README.md) was exported with Godot 4.7.2 and its matching Web templates and exercised on macOS Electron. After running `node examples/godot-viewer/export.cjs` and `pnpm build`, `pnpm --filter @industrial-agent-harness/desktop test:godot` binds the example as a normal project in isolated temporary application data. It opens the real export from the project file tree, verifies a rendered canvas and bridge handshake, confirms that pause freezes the actual Robot position and single step changes it while leaving the scene paused, selects a camera, enters/exits fullscreen and opens all three asset viewers. HTTP requests are blocked and the test asserts zero attempted external requests. Export binaries are generated locally and ignored by Git. Linux, Windows and packaged desktop distributions have not been exercised.

## Shared view navigation

The workspace toolbar supplies zoom out/in, Fit and fullscreen. Wheel or trackpad pinch over the runtime canvas magnifies the preview; Shift+wheel retains normal scrolling. Scaling uses the existing iframe with a CSS transform and scrollable preview area, so the scene camera, playback state and bridge session remain intact. Fit restores 100% and clears preview scrolling. This display scale is separate from the Camera selector.
