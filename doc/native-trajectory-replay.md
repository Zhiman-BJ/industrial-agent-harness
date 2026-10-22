# Native trajectory replay (internal edition)

Issue: [#275](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/275),
within the read-only replay scope accepted by PD-070 and #105.

## Open a recording

From the repository root with the normal Desktop development dependencies installed:

```bash
node apps/desktop/internal/replay/launch.cjs --replay /absolute/path/to/trajectory.tar.gz
```

The same entry accepts a native export directory or a Harness recording directory
(`recording.json` + `events.jsonl`). It builds its own renderer and launches an
isolated internal Electron composition. It is not a flag on the public application
or an installed-package feature. The public desktop entry does not import it.

The header identifies historical replay, source coverage and per-agent counts.
Play, pause, speed, timeline position and reset operate on the shared deterministic
engine. Agent filters and 100-record pages expose every reached source record;
source JSON is expanded on demand. Text, thinking, tool arguments, tool results,
compaction summaries and original timestamps remain inspectable. A final source
position means all recorded events were consumed, not that the underlying RTL
passed engineering acceptance.

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

## Verification

```bash
node --test packages/harness-recording/tests/*.test.cjs packages/harness-replay/tests/*.test.cjs apps/desktop/internal/replay/controller.test.cjs tests/integration/native-replay.test.cjs
node scripts/verify-native-replay.cjs /absolute/path/to/trajectory.tar.gz /absolute/path/to/report.json
INDUSTRIAL_UI_SCREENSHOTS=/absolute/path/to/ui-evidence node apps/desktop/internal/replay/launch.cjs --replay /absolute/path/to/trajectory.tar.gz --replay-selftest
pnpm test:architecture-contract
pnpm test:architecture
pnpm test:editions
```

The corpus verifier independently reads original per-agent wire data and checks
source identity/order, exact raw data and content/tool projection, then compares
full playback, seeking and resetting. Model, process, network and filesystem
mutation paths are replaced with fail-on-call guards during import and replay.
The Electron selftest exercises the real renderer, playback controls, all-agent
pagination and endpoint coverage, and saves screenshots plus a receipt. It uses
an isolated user-data directory and never constructs a live task session.

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
