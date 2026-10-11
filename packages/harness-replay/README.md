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
  Replay renders exactly what live mode rendered from the same events.
  `foldDisplay(records, upto)` recomputes the display state for any prefix;
  `runningAt` / `terminalAt` derive the honest per-turn running/terminal
  state (an interrupted trajectory stays "running" at its tail — the run
  never settled).
- **Timeline** (`src/timeline.cjs`): source-time → display-time mapping
  with configurable long-wait compression (default: gaps over 5s compress
  to 1.5s; `thresholdMs: Infinity` disables). Event order and original
  timestamps are preserved for the UI.
- **Engine** (`createReplayEngine`): timer-free deterministic state machine.
  `play`/`pause`/`setSpeed`/`seek`/`seekToPosition`/`reset`/`tick(deltaMs)`.
  Playback advances incrementally; seek recomputes from zero; both are
  pinned equal at every position by tests. Reaching the end auto-pauses.
  Reset restores a fresh engine exactly (including speed).
- **Clock** (`createReplayClock`): the only place a timer exists. Owns the
  host interval with strict cleanup — double start replaces, dispose is
  idempotent, callbacks never fire after dispose, and stale callbacks are
  inert.
- **Describe** (`describeBundle`): explicit bundle status/outcome/gaps for
  the replay UI ("录制回放" identification, missing assets, interruption
  evidence, demo/review state).

## Not in this package (yet)

- Any UI mounting (ReplaySession, AgentFlow wiring, viewer degradation for
  godot/waveform/kicad iframes) — that is the #102 internal extension
  surface plus #105's UI PR.
- The fail-on-call application sandbox: the closure test here pins the
  structural half (pure-node imports, no execution-reachability markers);
  the full "model/tool/network replaced with fail-on-call, zero calls"
  acceptance needs the composed application and belongs to that wiring PR.

## Consuming bundles

Load with `@industrial-agent-harness/harness-recording`'s `loadBundle`, then
feed `bundle.events` to `createReplayEngine`. The recording fixtures
(`packages/harness-recording/fixtures/`) are the standard inputs:
`success-demo` and `interrupted-demo` together cover the healthy path and
every tolerated damage class.
