# Harness current gateway: real Chip execution

Tested 2026-10-16 at 23:50 UTC on macOS. This is a real remote run through
`RemoteSettings → createProjectRuntime → Broker scope → IndustrialRuntime → protected MCP`,
using the desktop application's normal Obol login. The diagnostic passed explicit
upload/execution approval and used no model inference. The two input files are a small
testbench, not evidence that arbitrary Chip projects or other domains are qualified.

| Record | Actual value |
| --- | --- |
| Remote project | `71c9cca7-7db5-420e-85f2-9ba7ad9d6838` |
| Snapshot | `dad30b9d-5780-4860-a86e-352b13b1e219` |
| Application session | `09ff814d-e60f-4140-af9d-125380595dda` |
| Sandbox | `fc395809-098d-4201-9861-a7bd4367c536`, generation 1 |
| Provider | Tencent, `ap-guangzhou` |
| Tool | `chip.rtl.verify` |
| Request | `55246107-90eb-4746-a1d3-631994c2587f` |
| Local action | `2973efdd-c0d5-4d58-834c-9263667b580a` |
| Outcome | `completed`; source verifier `chip.rtl.assertions`: `passed` |

`receipt.json` preserves the actual remote response, including the source verification,
lease, logs and remote artifact IDs. `result.json` contains the resulting local canonical
records and remote session. Credentials are excluded; the session principal is omitted.
The original response has `state: null`; no remote stage or server Run/Action/Checkpoint
is inferred. The local verifier is explicitly `remote.reported`.

The log, simulation report and VCD were downloaded and checked against their response
SHA-256 and sizes (4270, 615 and 360 bytes). Local Run/Action/State/Checkpoint records
were reopened read-only and compared to the returned result. The actual Desktop project
details page listed all three files, and its Download to project action fetched the VCD
with the same SHA-256. The approved input files are retained alongside the outputs.

Validation for this change:

- 58 targeted auth, client, runtime, session and architecture-policy tests passed.
- Architecture checker, desktop TypeScript check and Vite build passed.
- Architecture candidate-fetch suite: 8/9 passed; the unchanged oversized-materialization
  test got `spawnSync git ENOBUFS` instead of its expected `size limit` message on this host.
- Existing local industrial-core suites: 0/9 passed in this checkout, with missing Pack
  Python environment, invalid local runtime distribution lock and denied loopback listen.
  These gates are not reported as passing; they are separate from this successful remote run.

Limitations of this diagnostic: no live model-driven chat was exercised; a later
[MiniMax-M3 Desktop conversation](../remote-chat-20261017/README.md) covers that path.
The current service has
no invocation lookup for unknown outcomes; interrupted result import needs operator
handling. No unknown mutation was replayed during this test. Earlier discovery failures
occurred before execution; the saved client session and project were reused.
