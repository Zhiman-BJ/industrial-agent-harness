# PCB 3D acceptance progress, 2026-10-20

The source-derived preview is implemented; native GPU acceptance is pending.

## Completed checks

- TypeScript/Vite desktop build passed.
- Viewer Node suite: 67 passed, 1 existing KLayout availability skip, 0 failed (68 total).
- Desktop Node suite: 102/102 passed after integrating the macOS startup fix and the Fit-baseline regression tests (82/82 before those changes).
- Architecture suite: 48/48 passed. Temporary downloaded fixtures are outside the Git worktree; no checker or policy exception changed.
- Geometry-specific tests: 15/15 passed, including nonuniform stackups, malformed outlines, source-declared thickness, unsupported dielectric sublayers, duplicate/out-of-order copper, and unsupported pads.
- Rendering-budget tests: 10/10 passed, including rotated slot area, blind-via spans, complete drill masks, cancellation, preallocation rejection of a million-point line and oversized polygon, body extrusion bounds and bounded dense-hole topology checks.

## Independent source reconciliation

The official KiCad `video` board and license are identified in [fixtures.md](fixtures.md). Its unchanged source SHA-256 is `f620675158ddd5c61e5ce9e15f4c92b230ae1df1cbcec6c502b8ce266e4007ea`.

| Item | Source | Captured |
| --- | ---: | ---: |
| Track segments | 7,932 | 7,932 |
| Pads | 2,118 | 2,118 |
| Vias / via drills | 808 | 808 |
| Drilled pads / pad drills | 912 | 912 |

Capture produced 18,591 primitives and 1,720 holes, `complete: true`, with physical four-layer stackup coordinates. A local CPU capture took approximately 126 ms. This excludes source loading, WebGL triangulation, upload and painting; it is not a first-frame performance claim.

## Native GPU gate

The prepared source GUI entry loads the real PCB worktree and `--kicad-selftest`, with the real board supplied by `INDUSTRIAL_PCB3D_FIXTURE`. It records the exact `KiCad selftest passed:` marker, source hashes, true mouse picks, navigation/fullscreen/language retention, GPU context-loss recovery, heartbeat gaps, and 100 ms process working-set samples. A newly prepared app alone is not a test pass.

The first actual run (`b42d4c0f-a95a-41cc-a8c2-6c4bfcc86b4c`, attempt `b5648117-0ae3-4f4a-b14f-0393ac19bb22`) entered main at `2026-10-20T05:34:13.355Z` and exited 1 at `05:34:49.453Z`. It stopped in the existing 2D `hierarchy.kicad_sch` Fit check, before entering any PCB 3D scene. During baseline sampling, the canvas changed from 337×658 to 450×609 while its zoom remained 6.08742774566474; Fit then correctly changed zoom to 8.128612716763007, proportional to the new width. The test compared against its stale pre-resize baseline because it sampled zoom stability without layout stability. The cause of the native layout change itself is not established. This run supplies no 3D performance or GPU acceptance evidence.

The navigation selftest now accepts an atomic scale/layout snapshot. During baseline acquisition, a layout change refits the viewport and resets stability sampling within the same deadline; after the baseline is established, a layout change raises an explicit failure rather than silently refitting. The original zoom and 1% Fit thresholds are retained. Three CPU regressions reproduce the stale-zoom resize, an endlessly changing layout, and a not-ready viewport. The updated native suite still requires a new run.

Still required: a completed native run, screenshot inspection of copper/drill/board alignment, layer isolation and top/bottom occlusion, measured load/heartbeat/memory results, and any fixes revealed by that run. No packaged Windows/Linux 3D runtime or manufacturing acceptance is claimed.

## Actual component-model follow-up

The initial preview rendered source board geometry and footprints without component bodies. This did not satisfy the user's expectation of an assembled PCB view. The implementation now reads actual footprint model references, applies KiCad's native front/back placement and model transforms, loads project-local STEP/static WRL resources in a terminable Worker, and renders shared meshes as footprint-identified instances. Missing, unsupported and over-budget models remain explicit; no placeholder bodies are invented.

The unchanged video board contains 189 footprints, 175 visible model references and 27 unique model files. All 27 original WRL files (4,473,258 bytes) were recovered from fixed official library/source revisions and checked against their Git blob identities. The local fixture's `models.provenance.json` records paths, URLs, revisions, SHA-256 and license files. A parser/capture reconciliation confirmed source placement, reference and model index identity, with 86 front and 103 back footprints, and no invalid model transforms.

Latest CPU checks: Viewer 106 passed / 1 existing availability skip / 0 failed (107 total), Desktop 103/103, architecture 48/48. Focused coverage includes geometry 21/21, renderer budgets 18/18, WRL 12/12, and the component loader 9/9. The real pinned STEP WASM imports a real test model; its memory-section adaptation is tested to reject growth beyond 256 MiB linear memory. This is not a total Worker process-memory bound.

The ordinary source app `f8f857be-fdc8-478b-9268-68241e54b6f7`, attempt `10e4efbf-ac7d-4894-a8be-00ca733fb010`, entered main at `2026-10-20T07:17:55.722Z`. The real video project was opened through the Project file tree, reached the ready 2D viewer and entered workspace fullscreen. The Computer Use transport disconnected during the 3D-button action. Its subsequent connection/reset returned `Transport closed`; one delegated reconnection also failed to return state and was interrupted. No actual component-rendering screenshot or native GPU result has been obtained. These remain pending, regardless of CPU-test success.

The separate GDS error was traced to a missing per-worktree KLayout Python environment. Installing the pinned dependency and using the product RasterService rendered the real Sobel GDS (22 layers, 1200×800) without changing the source. The setup now uses standard `venv --copies`; the canonical source contract subsequently passed without changing its checker or policy. The host KLayout Python environment is still not managed by the shared dependency manager.
