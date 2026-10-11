# @industrial-agent-harness/harness-recording

Internal-edition recording bundles for real chat tasks (#104, permitted by
PD-070). A bundle is a plain directory — `recording.json` (manifest) +
`events.jsonl` (ordered presentation events) + `assets/` (snapshots) — that
can be copied between machines with no access to the original project.

## Scope

- **Recorder** (`createRecorder`): observes presentation events exactly as
  TaskService.onEvent delivers them, before any UI-side streaming merge. It
  records a single chat per bundle, tags every event with its
  chat/project/turn origin, and never re-executes tasks or touches project
  evidence. Recorder faults (disk full, IO errors) seal the bundle
  `incomplete` instead of interrupting the live task; resource caps
  (`maxEvents`, `maxEventBytes`, `maxAssetsBytes`, `maxTotalBytes`) stop
  recording the same way.
- **Validator** (`validateManifest`, `validateEventStream`, `validateBundle`):
  deterministic checks for schema version, sequence monotonicity, time
  ordering, event vocabulary, manifest/stream count agreement, and asset
  size/hash integrity.
- **Loader** (`loadBundle`, `streamEvents`): offline, read-only bundle access
  for replay (#105). Crashed recordings (status `recording`) load as explicit
  interrupted evidence; structural corruption throws `RecordingError` with a
  stable code; missing assets surface as gaps, never silent holes.

## Not in this package (yet)

- Desensitization pipeline and demo-copy export (tracked by #104, next PR).
- Any composition into apps/desktop or the CLI — that wiring belongs to the
  internal extension surface defined by #102.
- Archive (zip) import — bundles are directories for now; if compression is
  added later it must validate path traversal, entry counts, compression
  ratio, and decompression totals before extraction.

## Fixtures

See `fixtures/README.md`. Regenerate with `node scripts/build-fixtures.cjs`;
`tests/fixtures.test.cjs` pins each bundle's documented behavior.
