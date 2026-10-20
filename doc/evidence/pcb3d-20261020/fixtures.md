# PCB 3D validation fixtures

These files exercise display fidelity and resource handling. Rendering them does
not establish DRC, ERC, manufacturing, or mechanical acceptance.

## Existing regression fixtures

- `packages/viewer-builtin/fixtures/kicad/pads.kicad_pcb`: unchanged upstream
  KiCanvas geometry fixture, MIT. Source and pinned revision are recorded in
  that directory's README and license notice. It is synthetic test geometry.
- `examples/pcb-led/led.kicad_pcb`: Harness-authored two-layer demonstration board.
  It supplies a small, self-contained source for navigation, picking, language,
  and recovery regressions. It is not a complex-board acceptance sample.

## Real four-layer board: KiCad video demo

- Upstream: <https://github.com/KiCad/kicad-source-mirror> (official KiCad mirror).
- Release tag: `10.0.6`.
- Exact commit: `caf7377e9cb6fa1535ec3596dcb8c99bf44a996e`.
- Source: `demos/video/video.kicad_pcb`.
- Git blob: `e9adf841c19fcb881549b0c63b6fe5834a000328`.
- SHA-256: `f620675158ddd5c61e5ce9e15f4c92b230ae1df1cbcec6c502b8ce266e4007ea`.
- Size: 5,787,523 bytes; version field `20241229`, generator version `9.0`.
- License: **CC BY-SA 4.0**. The upstream `LICENSE.README` explicitly assigns
  this license to all `demos/*`; retain it with `LICENSE.CC-BY-SA-4.0` when
  distributing the demo source.

Independent source inventory on 2026-10-20:

| Item                             |                           Source count |
| -------------------------------- | -------------------------------------: |
| Copper layers                    | 4 (`F.Cu`, `In1.Cu`, `In2.Cu`, `B.Cu`) |
| Footprints                       |               189 (86 front, 103 back) |
| Footprints with nonzero rotation |                                     96 |
| Pads                             |                                  2,118 |
| Track segments                   |                                  7,932 |
| Vias                             |                                    808 |
| Net entries                      |                  589 (including net 0) |
| Zones / filled polygons          |                                  2 / 8 |
| Model references                 |                                    175 |
| Lexer tokens                     |                              1,069,154 |

The board has a nonrectangular outline made from straight Edge.Cuts lines.
It has no `gr_arc` or oval drill entry, and its three dielectric sections have
equal thickness. Use separate geometry boundary fixtures to exercise circular
outlines, internal routed cutouts, slots, and nonuniform stackups.

The model references use `${KICAD6_3DMODEL_DIR}`. The source board alone does not
include those external models. A test using only this file must report model
availability honestly rather than drawing invented component bodies.

The large board is downloaded for local validation and is not committed as a
multi-megabyte fixture. To reproduce, download the following files into one
temporary directory, preserving the source board bytes:

- <https://raw.githubusercontent.com/KiCad/kicad-source-mirror/caf7377e9cb6fa1535ec3596dcb8c99bf44a996e/demos/video/video.kicad_pcb>
- <https://raw.githubusercontent.com/KiCad/kicad-source-mirror/caf7377e9cb6fa1535ec3596dcb8c99bf44a996e/LICENSE.README>
- <https://raw.githubusercontent.com/KiCad/kicad-source-mirror/caf7377e9cb6fa1535ec3596dcb8c99bf44a996e/LICENSE.CC-BY-SA-4.0>

Then build the current desktop and run the production-path regression:

```sh
pnpm --filter @industrial-agent-harness/desktop build
INDUSTRIAL_PCB3D_FIXTURE=/absolute/path/video.kicad_pcb pnpm --filter @industrial-agent-harness/desktop test:kicad
```

The selftest copies the supplied board into its isolated temporary project as
`complex.kicad_pcb`; it never edits the original. The normal command without this
environment variable keeps the smaller committed regression fixtures. Reports
include the copied source size/hash, initial 3D load time, renderer heartbeat,
WebGL geometry, selected source objects, and screenshot paths.

## macOS GUI acceptance after restricted-shell diagnosis

When the host's shell cannot register with LaunchServices or WindowServer, use
an isolated source GUI bundle prepared by `apps/desktop/scripts/mac-gui.cjs`
from the startup-fix branch. Keep its actual `desktopRoot` pointing at the PCB
worktree and launch the returned `.app` through the GUI session.

The local real-board resource is outside the Git worktree at
`$PROJECT_ROOT/work/pcb3d-fixtures/video/video.kicad_pcb`. Supply the absolute
path as `INDUSTRIAL_PCB3D_FIXTURE`; optionally set
`INDUSTRIAL_UI_SCREENSHOTS` to an absolute, private output directory. Neither
path is a built-in product fixture selector.

A completed suite emits the exact `KiCad selftest passed:` marker only after
all 2D and 3D checks pass. Match that marker, a final exit code of zero and the
same launch attempt identity when interpreting the GUI launcher's result.
Seeing a window or reusing a previous successful result is insufficient.

Opening this selftest entry immediately drives the temporary project through
file, zoom, fullscreen, layer and language checks, then exits. Use an entry
prepared without a selftest flag for an ordinary interactive demo window.

The 3D checks use a real WebGL context, nonzero submitted triangle and draw-call
statistics, real Chromium mouse input for raycasting, exact positive-net
highlighting on two source objects in one layer, source UUIDs from the loaded
board, unchanged source hashes, layer controls, exploded view, camera retention,
language switching and deliberate graphics-context loss followed by usable 2D
navigation. Screenshot inspection remains necessary for board holes and
coordinate fidelity; rendering statistics alone do not establish them.

The Electron selftest samples `app.getAppMetrics()` every 100 ms for the
`Browser`, `Tab` and `GPU` process classes. It reports their initial/final
working sets, the largest sampled class totals and each process identity.
Values are KiB (1024 bytes): the [official MemoryInfo documentation](https://www.electronjs.org/docs/latest/api/structures/memory-info)
calls the unit kilobytes, and Electron's [GetAppMetrics implementation](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_app.cc)
converts bytes with `>> 10`. The sum of individual process lifetime peaks is
reported separately; it is not a simultaneous application peak or GPU VRAM
measurement. Sampling can miss short spikes and shared pages can be counted in
more than one process. `kicad-memory.json` preserves the suite observation even
when another assertion fails. Memory observations do not impose a hardware-
dependent pass threshold.
