# @industrial-agent-harness/harness-replay

Offline, read-only replay of recording bundles (#105, permitted by PD-070).
Deterministic playback of a recorded trajectory with no access to the
original project, chat store, model, or runtimes — the package requires
only node builtins at runtime, and a closure test pins that.

## Scope

- **Display reducer** (`src/display-reducer.cjs`): a faithful port of the
  live `appendDisplayEvents` merge semantics from
  `apps/desktop/src/agent-events.ts` (streaming text/thinking merge,
  subagent-state dedup by id, status/step rows kept out of the merge slot).
  Legacy recordings retain live display semantics. Native imports additionally
  keep streaming text/thinking separate by `replayAgentId`, `replayTurnId`,
  and `replayRole` (for example, a user prompt and its assistant response).
  `foldDisplay(records, upto)` recomputes any prefix in one batch;
  `runningAt` / `terminalAt` derive the honest per-turn running/terminal
  state (an interrupted trajectory stays "running" at its tail — the run
  never settled). Identified multi-agent recordings derive overall lifecycle
  from `main` (then `root`, or the first lane for a child-only recording), so
  child terminals cannot settle the parent turn.
- **Timeline** (`src/timeline.cjs`): source-time → display-time mapping
  with configurable long-wait compression (default: gaps over 5s compress
  to 1.5s; `thresholdMs: Infinity` disables). Event order and original
  timestamps are preserved for the UI. Binary-search lookup includes every
  event sharing the selected timestamp.
- **Engine** (`createReplayEngine`): timer-free deterministic state machine.
  `play`/`pause`/`setSpeed`/`seek`/`seekToPosition`/`reset`/`tick(deltaMs)`.
  Playback advances incrementally; seek recomputes from zero; both are
  pinned equal at every position by tests. Reaching the end auto-pauses.
  Reset restores a fresh engine exactly (including speed). Lifecycle state is
  indexed once so repeated snapshots do not rescan native metadata tails.
- **Clock** (`createReplayClock`): the only place a timer exists. Owns the
  host interval with strict cleanup — double start replaces, dispose is
  idempotent, callbacks never fire after dispose, and stale callbacks are
  inert.
- **Describe** (`describeBundle`): explicit bundle status/outcome/gaps for
  the replay UI ("录制回放" identification, missing assets, interruption
  evidence, demo/review state).

## Desktop consumer and boundaries

- The isolated internal Desktop composition lives at `apps/desktop/internal/replay`;
  it consumes this engine without constructing a live task session. See
  [Native trajectory replay](../../doc/native-trajectory-replay.md) for opening
  native exports, playback controls and full-corpus verification.
- The package closure test pins pure-node imports. The internal Desktop
  selftest and `scripts/verify-native-replay.cjs` additionally exercise the
  composed importer/player with fail-on-call guards and zero live calls.

## Consuming bundles

Load with `@industrial-agent-harness/harness-recording`'s `loadBundle` (recording
directories) or `await loadReplayInput(path)` (including native exports), then
feed `bundle.events` to `createReplayEngine`. The recording fixtures
(`packages/harness-recording/fixtures/`) are the standard inputs:
`success-demo` and `interrupted-demo` together cover the healthy path and
every tolerated damage class.
