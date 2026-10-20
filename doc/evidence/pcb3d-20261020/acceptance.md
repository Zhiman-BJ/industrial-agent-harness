# PCB 3D acceptance progress, 2026-10-20

The source-derived preview is implemented; native GPU acceptance is pending.

## Completed checks

- TypeScript/Vite desktop build passed.
- Viewer Node suite: 67 passed, 1 existing KLayout availability skip, 0 failed (68 total).
- Desktop Node suite: 82/82 passed.
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

Still required: a completed native run, screenshot inspection of copper/drill/board alignment, layer isolation and top/bottom occlusion, measured load/heartbeat/memory results, and any fixes revealed by that run. No packaged Windows/Linux 3D runtime or manufacturing acceptance is claimed.
