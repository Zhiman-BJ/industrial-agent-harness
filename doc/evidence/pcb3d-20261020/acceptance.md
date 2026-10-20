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
