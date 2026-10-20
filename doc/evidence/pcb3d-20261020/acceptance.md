# PCB 3D acceptance progress, 2026-10-20

The source-derived preview is implemented; native GPU acceptance is pending. The checklists below record successive checkpoints; the official-model section records the later headless download and installation evidence.

## Completed checks

- TypeScript/Vite desktop build passed.
- Viewer Node suite: 67 passed, 1 existing KLayout availability skip, 0 failed (68 total).
- Desktop Node suite: 102/102 passed after integrating the macOS startup fix and the Fit-baseline regression tests (82/82 before those changes).
- Architecture suite: 48/48 passed. Temporary downloaded fixtures are outside the Git worktree; no checker or policy exception changed.
- Geometry-specific tests: 15/15 passed, including nonuniform stackups, malformed outlines, source-declared thickness, unsupported dielectric sublayers, duplicate/out-of-order copper, and unsupported pads.
- Rendering-budget tests: 10/10 passed, including rotated slot area, blind-via spans, complete drill masks, cancellation, preallocation rejection of a million-point line and oversized polygon, body extrusion bounds and bounded dense-hole topology checks.

## Independent source reconciliation

The official KiCad `video` board and license are identified in [fixtures.md](fixtures.md). Its unchanged source SHA-256 is `f620675158ddd5c61e5ce9e15f4c92b230ae1df1cbcec6c502b8ce266e4007ea`.

| Item                      | Source | Captured |
| ------------------------- | -----: | -------: |
| Track segments            |  7,932 |    7,932 |
| Pads                      |  2,118 |    2,118 |
| Vias / via drills         |    808 |      808 |
| Drilled pads / pad drills |    912 |      912 |

Capture produced 18,591 primitives and 1,720 holes, `complete: true`, with physical four-layer stackup coordinates. A local CPU capture took approximately 126 ms. This excludes source loading, WebGL triangulation, upload and painting; it is not a first-frame performance claim.

## Native GPU gate

The prepared source GUI entry loads the real PCB worktree and `--kicad-selftest`, with the real board supplied by `INDUSTRIAL_PCB3D_FIXTURE`. It records the exact `KiCad selftest passed:` marker, source hashes, true mouse picks, navigation/fullscreen/language retention, GPU context-loss recovery, heartbeat gaps, and 100 ms process working-set samples. A newly prepared app alone is not a test pass.

The first actual run (`b42d4c0f-a95a-41cc-a8c2-6c4bfcc86b4c`, attempt `b5648117-0ae3-4f4a-b14f-0393ac19bb22`) entered main at `2026-10-20T05:34:13.355Z` and exited 1 at `05:34:49.453Z`. It stopped in the existing 2D `hierarchy.kicad_sch` Fit check, before entering any PCB 3D scene. During baseline sampling, the canvas changed from 337×658 to 450×609 while its zoom remained 6.08742774566474; Fit then correctly changed zoom to 8.128612716763007, proportional to the new width. The test compared against its stale pre-resize baseline because it sampled zoom stability without layout stability. The cause of the native layout change itself is not established. This run supplies no 3D performance or GPU acceptance evidence.

The navigation selftest now accepts an atomic scale/layout snapshot. During baseline acquisition, a layout change refits the viewport and resets stability sampling within the same deadline; after the baseline is established, a layout change raises an explicit failure rather than silently refitting. The original zoom and 1% Fit thresholds are retained. Three CPU regressions reproduce the stale-zoom resize, an endlessly changing layout, and a not-ready viewport. The updated native suite still requires a new run.

Still required: a completed native run, screenshot inspection of copper/drill/board alignment, layer isolation and top/bottom occlusion, measured load/heartbeat/memory results, and any fixes revealed by that run. No packaged Windows/Linux 3D runtime or manufacturing acceptance is claimed.

## Actual component-model follow-up

The initial preview rendered source board geometry and footprints without component bodies. This did not satisfy the user's expectation of an assembled PCB view. The implementation now reads actual footprint model references, applies KiCad's native front/back placement and model transforms, loads project-local STEP/static WRL resources in a terminable Worker, and renders shared meshes as footprint-identified instances. Missing, unsupported and over-budget models remain explicit; no placeholder bodies are invented.

The unchanged video board contains 189 footprints, 175 visible model references and 27 unique model files. All 27 original WRL files (4,473,258 bytes) were recovered from fixed official library/source revisions and checked against their Git blob identities. The local fixture's `models.provenance.json` records paths, URLs, revisions, SHA-256 and license files. A parser/capture reconciliation confirmed source placement, reference and model index identity, with 86 front and 103 back footprints, and no invalid model transforms.

Earlier component-model checkpoint: Viewer 106 passed / 1 existing availability skip / 0 failed (107 total), Desktop 103/103, architecture 48/48. Focused coverage includes geometry 21/21, renderer budgets 18/18, WRL 12/12, and the component loader 9/9. The real pinned STEP WASM imports a real test model; its memory-section adaptation is tested to reject growth beyond 256 MiB linear memory. This is not a total Worker process-memory bound.

The ordinary source app `f8f857be-fdc8-478b-9268-68241e54b6f7`, attempt `10e4efbf-ac7d-4894-a8be-00ca733fb010`, entered main at `2026-10-20T07:17:55.722Z`. The real video project was opened through the Project file tree, reached the ready 2D viewer and entered workspace fullscreen. The Computer Use transport disconnected during the 3D-button action. Its subsequent connection/reset returned `Transport closed`; one delegated reconnection also failed to return state and was interrupted. No actual component-rendering screenshot or native GPU result has been obtained. These remain pending, regardless of CPU-test success.

The separate GDS error was traced to a missing per-worktree KLayout Python environment. Installing the pinned dependency and using the product RasterService rendered the real Sobel GDS (22 layers, 1200×800) without changing the source. The setup now uses standard `venv --copies`; the canonical source contract subsequently passed without changing its checker or policy. The host KLayout Python environment is still not managed by the shared dependency manager.

## Official model data: real headless integration

The report at `2026-10-20T08:15:13.646Z` exercised real official HTTPS → immutable Pack catalog → shared `DataLibraryManager` / `DataLibraryRegistry` → `KiCadRuntimeManager` manifest and bounded resource channel → pinned OCCT CPU STEP parser. [official-model-download.json](official-model-download.json) is the unmodified, host-path-free report. The board is a Harness-authored contract project with two explicit STEP references, one front and one back. It is not the complex video board and does not establish GPU placement, picking, appearance or engineering acceptance.

The consumed `kicad-3d` library is `10.0.7`, official source commit `8d4070daa0fa3f7a7f3c176f4ca7bffc4df392be`, catalog SHA-256 `f1a20d5edadd4f1dbac403d78591127f01c91bf22a3741d17b4e86b6be82a4e6`. The external owner change is [industrial-domain-packs PR #50](https://github.com/Zhiman-BJ/industrial-domain-packs/pull/50), commit `5cc78f4`. The catalog inventories 7,252 STEP files across 105 families; this inventory count is not a model-download or rendering-pass count.

| Official source model                           |  Bytes | Raw SHA-256                                                        | OCCT triangles | CPU parse |
| ----------------------------------------------- | -----: | ------------------------------------------------------------------ | -------------: | --------: |
| `Resistor_SMD.3dshapes/R_0603_1608Metric.step`  | 40,618 | `1875571c326d0d9e96f36b4efeb8094068ef7619f0a449c781caf0b49c2e5861` |            276 | 172.71 ms |
| `Capacitor_SMD.3dshapes/C_0603_1608Metric.step` | 43,450 | `4857b3dc717675bf1fb22edda622ac3b3ae03cf44d81eefaf3fa3ba3a86d84c1` |            380 |  52.69 ms |

Both raw files were fetched from the pinned official GitLab revision and checked against the catalog's independently computed SHA-256 and size. The catalog records verification of the original bytes against their official Git blob identities; a Git blob ID is not used as the resource SHA-256.

| Operation                                                        | Observed result                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Open and plan before explicit preparation                        | 0 model network requests                                                                         |
| Explicit cold acquisition and runtime opening                    | 2 models / 84,068 bytes, 9,452.94 ms; measured separately from OCCT parsing                      |
| Warm offline open and prepare                                    | 70.04 ms, 0 network requests                                                                     |
| Deliberately corrupt one cached resource, then explicitly repair | Only that resource fetched again, 365.05 ms; 3 total requests across cold acquisition and repair |
| Read-only source handling                                        | Source unchanged through acquisition, parsing, offline reuse and cache repair                    |
| Deliberately mutate the source afterward                         | Existing manifest returns HTTP 409; preparation rejects the changed source                       |
| Renderer manifest                                                | No host filesystem paths exposed                                                                 |

These are single local measurements, not performance thresholds or whole-process memory claims. They do not establish throughput for all catalog models, complex-board GPU load, native UI interaction, public release installation or manufacturing correctness.

### Pack installation remains independent of model acquisition

[pack-data-library-install.json](pack-data-library-install.json) records installation of a 1,597,383-byte development builtin trusted bundle, bundle version `0.3.3`, using source release package `0.5.6` with content SHA-256 `0f8356f1a9651d26c4486b0bc2592b365b327f1befbf50afb7a6bd47cf43f1b3`. Its catalog contains the same 7,252 model entries and catalog digest. This installation prepared no native runtime and downloaded 0 model files. The explicit two-model download above is a separate operation in its own diagnostic cache.

This proves the development builtin bundle's data-library installation path. It is not acceptance of a public feed, release signatures or a native KiCad installation.

### Current regression checkpoint and remaining gates

At this evidence update, the final Viewer suite is 129 passed / 1 availability skip / 0 failed (130 total), Desktop 110/110, Pack Manager 99/99, domain-skills 20/20, architecture 48/48 and architecture-contract tests 20/20. The desktop TypeScript/Vite build passed, as did formatting checks for changed/untracked source and documentation and `git diff --check`. The focused model-download contract is 15/15, including retained A–B–A sessions, shared budgets, cancellation and retries, catalog/provenance replacement rejection, and full license `notice` / `exception` retention in acquisition authorization.

An additional CLI regression exposed a test-isolation defect: four cases supplied a replacement environment without the isolated configuration directory, so they attempted to use the real home configuration and were blocked by sandbox permissions. Only those test environments were corrected to use each case's existing temporary `projectDir/config`; all original assertions remain. The focused `apps/cli/tests/cli.test.cjs` run passed 8/8. The full CLI suite subsequently passed 31/31, including the packaged headless entry, with `INDUSTRIAL_HARNESS_CONFIG_DIR` also directed to an isolated diagnostic directory. This is a test-isolation correction, not a production permission or configuration change. Changed-source lint completed without errors.

Native GPU screenshots and the completed real complex-board desktop selftest remain outstanding, including actual top/bottom placement and picks, model appearance, navigation/fullscreen/language retention, load/heartbeat/memory observations and context-loss recovery. The PR remains Draft at this checkpoint. The local KLayout Python repair described above still does not complete shared dependency-manager integration.

### Reproduction

From the repository root, with dependencies installed and the consumed PCB Pack exposing the pinned official library:

```sh
node scripts/verify-pcb-model-download.cjs /absolute/path/to/a/new/pcb-model-diagnostic
```

This is an explicit network diagnostic. It downloads the two declared official STEP files into a private cache below the supplied output directory, creates its contract project, deliberately corrupts one diagnostic cache entry for repair and finally mutates that diagnostic source to exercise stale-source rejection. Use a fresh output directory separate from user projects. Unit and CI contract tests remain offline.

For a Node CLI that supports corporate environment proxies, the same diagnostic can use:

```sh
node --use-env-proxy scripts/verify-pcb-model-download.cjs /absolute/path/to/a/new/pcb-model-diagnostic
```

The proxy flag applies to this Node diagnostic process only. The resulting `report.json` records actual model URLs, raw digests, timings, network counts and rejection checks; a successful headless run does not imply a GUI or GPU pass.
