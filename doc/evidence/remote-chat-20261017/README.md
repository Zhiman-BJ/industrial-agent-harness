# MiniMax-M3 Desktop conversation: real remote Chip execution

Tested 2026-10-17, 00:07–00:10 UTC, against Harness commit `08523a4` on macOS.
The actual Desktop composer ran the pinned `@moonshot-ai/kimi-code@2.1.1` kernel
with `MiniMax-M3`, `openai_legacy`, and `https://api.minimaxi.com/v1`.
The model described the protected tool, requested execution, received the approved
result, read this run's report/log, and completed its Chinese reply. The UI showed
`Remote task completed`, `Engineering verification passed`, and `Turn finished`.

This exercises Desktop → shared task API → Kimi → Broker/approval → shared Runtime
→ protected remote MCP → real sandbox → source Verifier → local canonical records
→ model result. The earlier no-model diagnostic was disabled before this turn;
its completed remote session was explicitly stopped to release sandbox capacity.
The new project was bound through Desktop and only `eda.yaml` and `smoke_tb.sv`
were reviewed and uploaded. The remote service used normal Obol login; the model
used the user-provided MiniMax credential, held in session memory. Credentials and
model thinking are excluded from this evidence directory.

| Record | Actual value |
| --- | --- |
| Chat | `b5e46166-06f7-48f0-aed4-923cecda97a1` |
| Turn | `a5fe98a2-cc70-4f30-8a1b-43855b435b2f` |
| Remote project | `70c59b8a-159d-4da0-866d-745488ade85f` |
| Snapshot | `90961567-7eec-4345-91e8-b57de7332d72` |
| Application session | `d2578e14-1c5b-4a83-8df5-088cd6d5a45b` |
| Sandbox lease | `add7b570-df58-46b6-a107-68b38cf7f276`, generation 1 |
| Provider | Tencent, `ap-guangzhou` |
| Tool | `chip.rtl.verify`, version `0.6.1-core.2` |
| Request | `4b988ce1-eb86-4bf0-86ed-c8194f37ad38` |
| Local Run | `6145c20e-a07f-4f7d-b583-e3239b3fcc75` |
| Local Action | `f6ac009f-35a1-41cb-9753-b3beee8552c8` |
| Source Verification | `f91b4e56-c217-4643-897e-f5e992f037ee`, `chip.rtl.assertions`, `passed` |
| Local Verification | `aa2023c7-3bae-4334-900e-8cc2e723645c`, `remote.reported`, `passed` |
| Local State | `eb6d4958-1129-4c38-a13b-3914ef7851d4`, `verified`, stage `null` |
| Checkpoint | `fa4e073a-7f66-48f3-a7c5-41dc7cd6d10e` |

## Verification performed

- Exactly one model call to `chip.rtl.verify` and one remote invocation journal
  exist for this chat. Both identify the request above; it completed with
  `needsImport: false`. No remote mutation was replayed.
- The execution approval is recorded as `9132c2d1-8a1a-43d4-a788-1605cb36e095`.
  Approval mode remained Request approval.
- Both input hashes still match the approved snapshot and canonical Action.
- All three downloaded outputs match the source receipt and canonical artifact
  sizes and SHA-256: log 4270 bytes, simulation report 615 bytes, VCD 360 bytes.
- `IndustrialRuntime.openRecords` reopened Run, Action, State, Verification,
  Checkpoint and artifacts read-only. Their identities and values match the tool
  result delivered to the model. The checkpoint contains that same State.
- The source `chip.rtl.assertions` verifier reports completion, a real waveform,
  and no assertion failure. The report records native action `rtl.simulate`,
  Verilator 5.026, compile/simulation exit codes 0, and `PASS`. The source verifier,
  rather than exit codes or the model's wording alone, is the acceptance evidence.
- The final reply's request, Run, Action, State and Verification identities match
  the stored records. The server returned `state: null`; the verified State is a
  local wrapper of the attributed source result, not a server-generated State.

## Observed limits

This was an operator-approved conversation, not an unattended run. The model
initially requested Bash `ls`; the operator rejected it, and the command did not
execute. The model then used protected tools. One `project.files.read` call used
an invalid `paths` field, failed schema validation, and was corrected after tool
description. Those read actions do not establish engineering acceptance.

`model-final.md` preserves the visible final reply, excluding its thinking block.
Its last paragraph says `remote.simulate`; that is a prose error. The actual
canonical tool is `chip.rtl.verify`, and the native report action is `rtl.simulate`.
Canonical records and the source receipt remain authoritative.

This qualifies the small Chip smoke input on this deployed profile. It does not
qualify other projects/domains, CLI live model execution, or production recovery.
The later [Desktop result-opening follow-up](../remote-results-ui-20261017/README.md)
records a discovered artifact-opening bug, its fix, and actual report/VCD screenshots.
Current-service unknown outcomes still have no invocation lookup or automatic
replay; interrupted import still requires operator handling.

## Files and validation scope

`result.json` records the checks and input/output hashes. `receipt.json` contains
the actual remote response. `canonical-records.json` contains reopened local
records. `invocation.json` omits the account-bound service identity digest.
`tool-events.jsonl` retains only tool, approval and execution-boundary events from
this turn; duplicate empty argument events are stream updates, not repeated calls.
The input and three output files are copied byte-for-byte.

This commit adds evidence and documentation only. The implementation's 58 targeted
passing tests, architecture/TypeScript/build checks, and explicitly recorded
environment-related failing gates remain documented in the
[preceding implementation acceptance](../remote-gateway-20261016/README.md).
The live conversation and the file/record comparisons above are additional checks;
they do not change those gate results.
