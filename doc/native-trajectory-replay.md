# Native trajectory replay (internal edition)

Issue: [#275](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/275),
within the read-only replay scope accepted by PD-070 and #105.

## Product UI requirement (PD-097)

The target is the complete normal Desktop experience: project/chat sidebar,
conversation flow, composer, project file tree and workspace. The earlier
`ReplayApp` that combined production components with a custom stage strip and
source pagination did not meet this requirement. Its previous UI/video receipts
remain diagnostic evidence, not acceptance of the current product experience.

The baseline is the official `desktop-v1.1.0-beta.9` Apple Silicon DMG, release
commit `39d7d3057b2b7ebe7db22ee72e9ced86d81b2776`, SHA-256
`6c2acd4d914a59993578075229d4411dc5ba7dde9e8e9be312507c0472f84d05`.
The production App and existing Viewer source files on this branch match that
release. The release's packaged `app.asar/dist` can be copied read-only and loaded
unchanged by an internal recorded-data host; a per-file hash manifest identifies
the frontend used for capture. No installed app or normal user profile is replaced.

The internal host loads the complete product frontend through the unchanged
production preload. Playback control and raw-ledger diagnostics use a separate
window outside the main captured product window. The
public application does not import this internal composition, and beta.9 itself
does not ship the new replay feature.

## Open a recording

```bash
node apps/desktop/internal/replay/launch.cjs --replay /absolute/path/to/recording
```

The default builds the normal Desktop renderer and supplies a read-only recorded
backend. It accepts a supported archive, native export directory or ordinary
recording directory. To use an already verified release frontend without a build:

```bash
node apps/desktop/internal/replay/launch.cjs --replay /absolute/path/to/recording \
  --renderer-dir /absolute/path/to/extracted/app.asar/dist
```

The directory must contain the complete unchanged release frontend, including
`index.html` and assets. The host hashes its resources at startup and rejects
changed bytes or symlinks. `--receipt /absolute/path/to/receipt.json` saves the
frontend hashes, production preload hash and recording identity. `--position N`
opens a reached source position; `--hide-controls` hides the separate controller.
The title and receipt identify the internal recorded-data host. Composer, login,
model setup and other mutation requests are disabled or explicitly rejected; this
read-only session does not impersonate a configured live model.

Projects and per-agent chats use the production interfaces. Earlier turns use the
normal history control; complete raw records remain in the diagnostic interface.
Seek/reset reopen the selected chat through its existing handler. When the
historical snapshot changes, the host uses normal close/refresh/open-file controls
to reopen the selected file and restore its selected Viewer mode. It never writes
React state, replaces product markup or substitutes a PNG for the native canvas.

The former component-based shell is retained only for internal diagnostics with
`--legacy-shell`; it is not the default product recording path. A trusted local
capture driver may be explicitly selected by `--replay-capture <driver.cjs>` for
media automation. Drivers are host test code, never scripts selected by a
recording; model, industrial execution and network guards remain active.

## Recorded native Viewer

The internal snapshot provider maps each stage's `provenance.snapshotId` and
`sourceBoardSha256` to explicitly declared assets beneath
`assets/source/snapshots/<snapshotId>/`. It checks containment, symlinks, file
sizes and hashes before loading. The normal project file tree resolves
`board.kicad_pcb` to an artifact and Registry plugin; the unchanged production
KiCad runtime serves it to the existing Viewer at `app://kicad` beneath the
production `app://viewer` parent. The runtime's source/model manifest is checked
again against the recording, preventing a changed model from being accepted
merely because the runtime calculated a new hash.

The provider has no download service. Undeclared, absent or changed models fail
explicitly. Snapshot changes and resets release old tokens and invalidate old
artifact handles. Native 2D/3D, orbit, zoom, Fit and fullscreen are the existing
Viewer interactions and require real renderer verification. Source hashes and
Viewer readiness are not electrical or manufacturing verification.

Native recordings with no project snapshots keep their conversation and source
evidence without invented files. Explicitly constructed PNG demonstrations
remain [passive snapshot presentations](staged-artifact-replay.md), not native
interactive 3D acceptance.

## Supported native export

`agent-trajectory-export/1.0` must include `manifest.json`,
`events.timeline.jsonl`, `diagnostics.json` and `SHA256SUMS`. Checksums cover all
files, including raw wire and externalized result files. The importer reads only;
it never extracts the archive, executes scripts, resolves historical machine
paths, calls models or invokes tools. Resource bounds and stable `native:*`
errors reject unsafe or malformed inputs. A regular export directory must not
contain symbolic links. Zip and executable artifact playback are unsupported.

The exported timeline may be sorted by time even where native source lines are
out of order. The importer restores each agent's `source_line` order, merges the
lanes deterministically and adjusts presentation time only. Original timestamps,
source paths, line numbers, event identities and complete raw JSON remain on the
records. Cross-agent equal timestamps do not imply causal ordering. Unknown raw
event types remain metadata with their source JSON; canonical `context.append_*`
provides content, while `agent.message.appended` mirrors do not duplicate it.

No project snapshot was included in the DMA2D export. Historical file paths,
externalized-result references and tool observations stay evidence; replay does
not fabricate files, rerun verification or upgrade source failures to passes.

## Engine and historical-shell verification

```bash
node --test packages/harness-recording/tests/*.test.cjs packages/harness-replay/tests/*.test.cjs apps/desktop/internal/replay/controller.test.cjs tests/integration/native-replay.test.cjs
node scripts/verify-native-replay.cjs /absolute/path/to/trajectory.tar.gz /absolute/path/to/report.json
INDUSTRIAL_UI_SCREENSHOTS=/absolute/path/to/ui-evidence node apps/desktop/internal/replay/launch.cjs --legacy-shell --replay /absolute/path/to/trajectory.tar.gz --replay-selftest
pnpm test:architecture-contract
pnpm test:architecture
pnpm test:editions
```

The corpus verifier independently reads original per-agent wire data and checks
source identity/order, exact raw data and content/tool projection, then compares
full playback, seeking and resetting. Model, process, network and filesystem
mutation paths are replaced with fail-on-call guards during import and replay.
The historical Electron selftest exercises the former ReplayApp renderer,
playback controls, all-agent pagination and endpoint coverage. Its receipt remains
valid for those checks only. Full production App and native Viewer interaction
acceptance must be recorded separately after the refactor. All replay hosts use
an isolated user-data directory and never construct a live task session.

## DMA2D acceptance, 2026-10-22

Tested locally on macOS Apple Silicon against
`dma2d_native_trajectory_20261022_134558.tar.gz`, SHA256
`6f3be6c1f40fea6e24d2db4ac4d75c16a4187ba7760c024e414d90b47d7d828b`.
All 3,878 source checksums match. Expected and reached coverage:

| Agent | Source events | Turns | Tool calls/results |
| --- | ---: | ---: | ---: |
| main | 5,126 | 1 | 547 / 547 |
| agent-0 | 2,847 | 1 | 347 / 347 |
| agent-1 | 26,731 | 4 | 2,885 / 2,885 |
| agent-2 | 1,249 | 1 | 140 / 140 |
| agent-3 | 1,738 | 1 | 196 / 196 |
| agent-4 | 2,249 | 2 | 245 / 245 |
| Total | 39,940 | 10 | 4,360 / 4,360 |

The source has 2,852 thinking blocks, 41 compactions and 100 tool-error results;
these are retained. Recorded root termination is successful. This statement
covers read-only trajectory replay on the exercised platform, without claiming
new engineering acceptance or packaged Linux/Windows support. The private
trajectory itself is not committed to the repository.

## Full product / native Viewer acceptance, 2026-10-23

The official beta.9 frontend was exercised on macOS Apple Silicon with the
recorded PCB sources. Three native historical boards opened through the normal
project file tree and Registry, with 15 distinct model resources and 63 rendered
component instances per stage. Actual WebGL triangles/draw calls, zoom, Fit,
wheel/pinch, fullscreen entry/exit and camera preset changes were checked. Old
tokens returned 404 after stage changes; backward seek restored the original
board hash and reset released the session. The runtime's four unavailable items
and reduced-detail warning remain visible. No engineering pass is inferred.

Run the real native test against a recording with declared source snapshots:

```bash
INDUSTRIAL_UI_SCREENSHOTS=/absolute/path/to/evidence \
  node apps/desktop/internal/replay/launch.cjs --replay /absolute/path/to/native-recording \
  --renderer-dir /absolute/path/to/verified-release-dist --replay-selftest
node --test apps/desktop/internal/replay/product-backend.test.cjs \
  apps/desktop/internal/replay/product-protocol.test.cjs \
  apps/desktop/internal/replay/native-viewer.test.cjs
```

The original corpus verifier and engine coverage remain necessary for native RTL
exports; the PCB Viewer test does not replace their event/order checks. A replay
reaching its final source position is separate from the recorded engineering
result. Original failure and pending approval evidence stay intact.

The original DMA2D archive also passed the complete beta.9 App path: all six
sidebar chats rendered their ten original turns and 4,360 tool entries, including
all 100 recorded tool failures. The largest lane rendered 2,885 tools across four
turns in about 1.56 seconds on this exercised machine. Removing raw source JSON
that the product renderer never consumes reduced aggregate history payloads from
161.7 MB to 43.2 MB; source-sequence indexes retain the mapping, and the diagnostic
interface still returns every original record. An independent traversal of all
39,940 records produced the same source/replay digest. These are local measured
results, not a general performance guarantee or a claim of engineering success.
