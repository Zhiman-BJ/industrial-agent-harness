# Current-user Agent and local model fixture — 2026-10-20

This record supplements the [earlier blocked attempt](live-attempt-20261020.md); it does not rewrite that attempt's evidence.

## Product change and regression

Commit `4d53f9a6d65032a49af42462aeb532693817fe44` implements PD-088: macOS, Linux and Windows launch the local Agent with current-user permissions. The Agent no longer requires Seatbelt or bubblewrap. Environment filtering, approval, supervised process cleanup, declared Runtime task isolation and remote service isolation remain.

[Harness CI 39366964001](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39366964001) completed successfully for that commit: all four Portable platforms, macOS/Windows packaged first-run and UI, Linux native Agent/engineering discovery/real RTL and recovery, packaged headless launcher, structure checks, and the aggregate gate. [Platform login CI 39366963935](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39366963935) also passed on macOS and Windows. Full immutable Linux installer, old-preview upgrade and host Docker installation stages were not selected by this non-full CI run.

Local focused validation included real Kimi native writes with approve/reject checks, external MCP, packaged background work, project Skill discovery, installer startup and process-group cleanup. The full local Portable run reported 852 passed, 12 failed and 6 platform skips out of 870. The failures were traced to outer environment restrictions on the default user profile/log directory and `hdiutil`; isolated-profile A/B checks, SDK tests and the packaged CLI test confirmed the profile cause. These failures were not changed into skips or passes. The clean CI runners above passed the complete Portable gate.

## Actual deployed-service attempts

The client ran locally; no cluster or OS security policy was weakened. A proposed private test-bundle transfer to a separate Pod was rejected by automatic approval review. That path was abandoned and the temporary Pod was deleted. Direct local connectivity subsequently succeeded:

- Remote ingress `/healthz`: HTTP 200, `ready: true`.
- Normal OIDC PKCE sign-in: successful, memory-only account (`persistent: false`).
- Platform model catalog: successful. Actual inference with catalog model `Qwen/Qwen3.8-27B` returned HTTP 403. The real Kimi process started with `current-user`, `osIsolation: false`, `projectWritable: true`, and the TaskService created a chat before any upload. No engineering action was dispatched in that attempt.

The user then explicitly requested a local mock model. The fixture in `scripts/remote-chat-model-fixture.cjs` only supplies OpenAI-compatible model responses on a keyed loopback endpoint. Kimi, TaskService, approvals, Runtime, snapshot synchronization, remote engineering calls and evidence validation remain real. Every subsequent state, input byte/hash, review ID and report reference is derived from actual tool responses. Unknown responses and failed actions stop the fixture. Its five tests cover the complete response sequence, Kimi's exact timing wrapper, failure handling, artifact integrity, keyed routes, body bounds and SSE.

The actual mock-model attempt successfully performed `project.files.read` and read its artifact through real Kimi. `project.remote.plan` then failed before upload with `Remote service is unavailable for this domain`. Its action ID was `03faac9a-b357-4d5f-ac4b-b522b16492bc`; there were zero approval prompts, zero remote runs and no pending remote task.

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

## Remaining live acceptance

After the version fix, terminal and browser-control connections disconnected during the next normal PKCE login. The terminal recovered; browser control still reported `Transport closed`, including its reset attempt. Earlier authenticated test accounts were explicitly logged out. The last uncompleted sign-in has a five-minute timeout and obtained no access token through this runner.

The final live sequence is **not yet passed**. Once normal browser sign-in is available, rerun `createChatAcceptance` with the explicit local model fixture and the deployed service. Required evidence remains: one batch approval plus one exact local edit approval, two real CAD verifications, automatic resynchronization of the approved file's changed bytes, no extra remote-tool approval, actual artifact hashes, report readback and released sessions. No mocked remote result may satisfy those checks.

No snapshot upload or CAD engineering call was reached in the attempts recorded here. This record verifies the local Agent change, the controlled-model path up to remote planning, and the discovered compatibility fix; it does not stand in for the remaining deployed execution test.
