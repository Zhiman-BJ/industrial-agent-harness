# Synthetic recording fixtures

Deterministic bundles exercising every documented loader outcome. Regenerate
with `node scripts/build-fixtures.cjs` after changing the recorder, the
schema, or the fixture scenarios; `tests/fixtures.test.cjs` pins the expected
behavior of each bundle.

These are synthetic demo data only: no real conversation, credential, or
project artifact is embedded.

| Fixture | Demonstrates | Loader result |
| --- | --- | --- |
| `success-demo/` | Complete run with a tool call and a captured artifact snapshot | `complete`, outcome `success`, 6 events, asset present |
| `tool-failure-demo/` | A tool-result with `error: true` inside an otherwise successful run | `complete`, failing event preserved |
| `cancelled-demo/` | User cancellation | `complete`, outcome `cancelled` |
| `interrupted-demo/` | Process crash mid-run: manifest still `recording`, torn final event line | loads as `incomplete` (`app-shutdown`) with truncation + count warnings |
| `corrupted-seq/` | Duplicate event sequence number | throws `events:seq` |
| `unknown-event/` | Event type outside the known vocabulary | throws `events:unknown-type` |
| `missing-asset/` | Asset marked `missing` in the manifest | loads with `missingAssets: ["lost-image"]` |

Replay development (#105) should build against `success-demo` and
`interrupted-demo` first: together they cover the healthy path plus every
tolerated damage class.
