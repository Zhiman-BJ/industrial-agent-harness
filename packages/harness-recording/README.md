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
- **Redaction** (`src/redact.cjs`): deterministic text rules for demo copies —
  secret-sounding keys lose their values (including inside JSON-encoded tool
  arguments), home paths drop the username, credential-carrying URLs, bearer
  tokens, common API-key literals, and private endpoints are masked, plus
  caller-selected literals. It makes no claim to recognize all sensitive
  content; that is what the human review step is for.
- **Demo export** (`src/demo-export.cjs`): `exportDemoBundle` copies an
  original bundle into a separate desensitized demo directory (the original is
  opened read-only and never modified), including only assets a human has
  explicitly cleared — everything else stays out and surfaces as an explicit
  missing-asset gap. `markDemoReview` records the review verdict on the demo
  manifest (`approved` requires `redaction.applied`). Every export and review
  update must re-pass bundle validation.

## Not in this package (yet)

- Any composition into apps/desktop — that wiring belongs to the
  internal extension surface defined by #102.
- Archive (zip) import — bundles are directories for now; if compression is
  added later it must validate path traversal, entry counts, compression
  ratio, and decompression totals before extraction.

## Fixtures

See `fixtures/README.md`. Regenerate with `node scripts/build-fixtures.cjs`;
`tests/fixtures.test.cjs` pins each bundle's documented behavior.
