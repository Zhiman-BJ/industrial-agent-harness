# Current-user Agent and deployed remote acceptance with a local model fixture — 2026-10-20

The final run passed at **2026-10-20 05:24:25 UTC**, using real TaskService, Kimi Code 2.1.1 and the deployed remote service, with an explicitly selected local mock model. The [compact acceptance record](live-acceptance-20261020/acceptance.json) contains both CAD runs, changed input hashes, new snapshots, artifact checks and confirmed releases. This was a headless shared-application run, without Electron UI interaction or a test of real-model autonomous planning.

This record supplements the [earlier blocked attempt](live-attempt-20261020.md) and retains the unsuccessful attempts below; it does not rewrite their evidence.

## Product change and regression

Commit `4d53f9a6d65032a49af42462aeb532693817fe44` implements PD-088: macOS, Linux and Windows launch the local Agent with current-user permissions. The Agent no longer requires Seatbelt or bubblewrap. Environment filtering, approval, supervised process cleanup, declared Runtime task isolation and remote service isolation remain.

[Harness CI 39366964001](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39366964001) completed successfully for that commit: all four Portable platforms, macOS/Windows packaged first-run and UI, Linux native Agent/engineering discovery/real RTL and recovery, packaged headless launcher, structure checks, and the aggregate gate. [Platform login CI 39366963935](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39366963935) also passed on macOS and Windows. Full immutable Linux installer, old-preview upgrade and host Docker installation stages were not selected by this non-full CI run.

Latest committed regression at `b53f086` also passed: [Harness CI 39368635034](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39368635034), [Platform login CI 39368635084](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39368635084), and [Architecture CI 39368635045](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39368635045). The full installer/upgrade stages were not selected; their absence is not reported as a pass. The final live rerun additionally includes the one-line qualification status-assertion correction described below.

Local focused validation included real Kimi native writes with approve/reject checks, external MCP, packaged background work, project Skill discovery, installer startup and process-group cleanup. The full local Portable run reported 852 passed, 12 failed and 6 platform skips out of 870. The failures were traced to outer environment restrictions on the default user profile/log directory and `hdiutil`; isolated-profile A/B checks, SDK tests and the packaged CLI test confirmed the profile cause. These failures were not changed into skips or passes. The clean CI runners above passed the complete Portable gate.

## Earlier deployed-service attempts

The client ran locally; no cluster or OS security policy was weakened. A proposed private test-bundle transfer to a separate Pod was rejected by automatic approval review. That path was abandoned and the temporary Pod was deleted. Direct local connectivity subsequently succeeded:

- Remote ingress `/healthz`: HTTP 200, `ready: true`.
- Normal OIDC PKCE sign-in: successful, memory-only account (`persistent: false`).
- Platform model catalog: successful. Actual inference with catalog model `Qwen/Qwen3.8-27B` returned HTTP 403. The real Kimi process started with `current-user`, `osIsolation: false`, `projectWritable: true`, and the TaskService created a chat before any upload. No engineering action was dispatched in that attempt.

The user then explicitly requested a local mock model. The fixture in `scripts/remote-chat-model-fixture.cjs` only supplies OpenAI-compatible model responses on a keyed loopback endpoint. Kimi, TaskService, approvals, Runtime, snapshot synchronization, remote engineering calls and evidence validation remain real. Every subsequent state, input byte/hash, review ID and report reference is derived from actual tool responses. Unknown responses and failed actions stop the fixture. Its five tests cover the complete response sequence, Kimi's exact timing wrapper, failure handling, artifact integrity, keyed routes, body bounds and SSE.

The first actual mock-model attempt successfully performed `project.files.read` and read its artifact through real Kimi. `project.remote.plan` then failed before upload with `Remote service is unavailable for this domain`. Its action ID was `03faac9a-b357-4d5f-ac4b-b522b16492bc`; there were zero approval prompts, zero remote runs and no pending remote task.

A separate normally authenticated read established the precise cause: the client accepted only product version `1.1.0`, while the deployed `/v1/service-info` returned:

```json
{
  "version": "1.2.1",
  "sessionModel": "application-session",
  "domains": ["cad", "chip", "cuda", "godot", "pcb"],
  "domainCatalogEntries": 5,
  "capabilitySnapshotHash": "10b6ec8d6020371a9df22b5e616a4c5be1233910f99193372dd5311ee1f6d6de"
}
```

The envelope had only `version`, `domains`, `domainCatalog`, `capabilitySnapshotHash` and `sessionModel`. CAD's catalog contained `cad.freecad.build`; catalog presence does not by itself qualify execution.

The client now recognizes stable `1.1.x` and `1.2.x` product versions under the same MCP v1 envelope, while retaining session/domain/catalog/hash validation and subsequent protected-tool checks. Unknown major/minor versions and prereleases remain rejected. One hundred focused remote preparation/current Runtime/planning tests passed, followed by a targeted `1.2.1` approval, canonical receipt, artifact and reopen/recovery regression. The available reference source documented the additive MCP v1 catalog contract; exact deployed commit `ef86089` source was not retrieved, so this record does not claim it was audited.

## Intermediate interruption and qualification correction

After the version fix, terminal and browser-control connections disconnected during the next normal PKCE login. The terminal recovered; browser control still reported `Transport closed`, including its reset attempt. Earlier authenticated test accounts were explicitly logged out. That uncompleted sign-in had a five-minute timeout and obtained no access token through its runner. These initial attempts reached neither snapshot upload nor CAD execution; the later completed runs are recorded separately below.

Once normal sign-in recovered, attempt `pr230-chat-89iYlp` completed two real CAD actions with passed verification, but its qualification runner failed the final assertion: it expected TaskService completion status `completed`, while the real TaskService contract returned `finished`. The qualification assertion was corrected to `finished`; engineering Actions still require `completed`. That earlier attempt remains a failed qualification run despite its successful CAD calls. A fresh run with new request identities then passed cleanly; the earlier calls were not replayed to manufacture a pass.

## Final live acceptance — passed

The successful isolated run was `pr230-chat-wTGZlx`, completed at `2026-10-20T05:24:25.669Z`. Its mode is `real-TaskService-real-Kimi-mock-model-real-remote-no-Electron`; the model fixture was `remote-chat-controlled-fixture` over the existing `openai_legacy` provider. The deployed endpoint was `https://industrial-mcp-remote-test.pvg1s1-cloud.internal.zhiman.tech`. Kimi Code 2.1.1 ran on macOS with `mechanism: current-user`, `osIsolation: false`, and `projectWritable: true`.

The actual sequence and checks were:

- A real `KimiSession` chat existed before any upload, with the local workspace and remote-planning tools available.
- Kimi read `recipe.json`, generated the exact-file/tool plan and called `project.remote.prepare`. One explicit batch approval authorized that file and `cad.freecad.build`; protected live discovery succeeded, and the preparation session was confirmed released.
- The first real CAD build completed with passed verification. One separate local-edit approval then allowed the fixture-driven Kimi to modify the already-approved `recipe.json` through the real workspace tool.
- The file hash changed from `1f9fdd40a5e462caec414574042f97e5dba38fe20490cbc7a8517d784cc15b82` to `f14e61eb18b1639e715a849e496ec7c7d7f0a87873771337755d48088e83f9c2`. The remembered exact-file authorization automatically uploaded those changed bytes into a new immutable snapshot before the second build.
- The second real CAD build also completed with passed verification. Both engineering sessions were confirmed released, and **22/22** downloaded artifacts passed size and SHA-256 checks across the two runs.
- The actual approval counts were **batch 1, local edit 1, remote tool 0, other 0 — two prompts total**. Repeated in-scope CAD execution added no remote-tool approval.
- Kimi read the real second-run `report.cad.execution` artifact (`186f29e7-8e91-41d7-8a43-48c34fc3653e`); the final answer contained both actual Action IDs. TaskService returned `finished`, with engineering status `verified`.
- The runner awaited `tasks.close()` before writing the passed `acceptance.json`. It exited **0**, and the normal account logout reported **`signed_out`**.

| Real CAD run                         | Action ID                              | Snapshot ID                            | Verification / release |
| ------------------------------------ | -------------------------------------- | -------------------------------------- | ---------------------- |
| 1 (`action-4.json`, `remote-1.json`) | `942a41b3-b7c0-46d0-86d3-ea4b1a7e532e` | `6339e3ab-f054-448b-a808-d2867a3af599` | `passed` / `released`  |
| 2 (`action-6.json`, `remote-2.json`) | `1081d29e-0aee-495f-9faa-60a8c66ba787` | `61986c1d-c84a-493b-92da-d829cfc3818f` | `passed` / `released`  |

The [retained compact evidence](live-acceptance-20261020/acceptance.json) preserves the actual identities, input hashes, approval counts, artifact checks and completion result. Original local evidence was written under `/var/folders/z0/8fqzv4jn6zb32j82pxz8mw2r0000gn/T/pr230-chat-wTGZlx/evidence/`; the repository copy is the reviewable record rather than relying on that temporary directory.

This passes the scoped shared TaskService/Kimi → plan → batch approval → real remote CAD → exact-file edit → automatic resynchronization → second CAD → report readback → release chain. Only model responses were supplied by the local fixture; remote results were not mocked. It does not establish Electron click-through E2E, autonomous planning by a real model, other Domain Pack/tool qualification, full installer acceptance or general network reliability. The earlier real-model HTTP 403 and connectivity failures remain recorded. No deployment or merge was performed for this acceptance.
