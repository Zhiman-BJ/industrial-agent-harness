# Windows Agent isolation candidate: native MXC

Issues [#223](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/223) and [#225](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/225) block protected Windows Agent startup even when industrial tools execute remotely. Kimi remains a local process. This candidate replaces the failed synthetic-SID backend with Microsoft MXC below the shared Kimi adapter. Desktop and CLI retain their shared task API, Broker, approvals and remote Runtime.

## Backend and dependencies

The production dependency is exactly `@microsoft/mxc-sdk@1.0.1`, with its registry integrity recorded in the lockfile. Harness uses its standalone `bin/<arch>/wxc-exec.exe`, not its JavaScript FFI. Electron 44 embeds Node 24.18.1, below the SDK's Windows native-stdio requirement of Node 24.21/26.8. The standalone executable preserves the existing ChildProcess streams without requiring an Electron upgrade or an upstream Kimi modification.

The launcher is read through Node, including from app.asar, checked against an architecture-specific SHA-256 digest, and materialized with the MIT license into a host-owned directory outside Agent writable storage. Its PE imports are Windows system libraries; Harness does not execute host-preparation, audit, proxy or VM helpers. The complete installed SDK package retains its upstream license and binary manifests. No startup downloads are performed.

A small original C# supervisor is compiled using the installed .NET Framework 4 compiler. It binds the local MXC executable and request file, checks NTFS and writable-tree reparse/hardlink constraints, and starts MXC suspended with only the three standard handles inherited. It assigns a kill-on-close Job before resuming and watches the captured parent process handle. Normal exit, cancellation and host exit terminate the owned descendants. Cleanup confirmation failure returns an error.

## Policy

Harness supplies the exact stable `1.0.0` JSON contract. It explicitly selects `processcontainer`, sets `fallback.allowDaclMutation: false`, and requires native host-loopback access. A request-aware `--probe` must report `base-container`, no DACL augmentation, no error, and the required native capabilities before launch. The same strict policy is enforced again by the executor; a failed launch does not try another backend. Generic platform support or an OS build number is insufficient evidence.

Only session storage and scratch are granted write access. Existing host reads are represented as read-only grants; immediate volume children are included because MXC volume-root grants are not recursive. Project, canonical records, runtime, supervisor and policies remain outside the writable roots. The environment is explicit and filtered; the native launcher does not restore the host's default environment. TCP egress and host loopback remain enabled for model APIs and authenticated host tools. Private-network inbound access is denied; no egress filtering is claimed.

The supervisor does not change host file or device ACLs, integrity labels, users or firewall configuration. MXC's CLI checks orphaned ACL journals before probing, so Harness gives it a fresh per-boundary `MXC_DACL_STATE_DIR`; it cannot sweep another MXC consumer's saved journals. That override is supplied only to the trusted executor, independently of the Agent's JSON environment. Telemetry is disabled.

Microsoft documents native process isolation beginning with updated Windows 11 24H2/25H2 builds; actual runtime capabilities remain authoritative. Older Windows, Server runners and managed devices without those capabilities must fail visibly. There is no restricted-token, AppContainer/DACL, administrator or unprotected fallback. See [MXC platform requirements](https://github.com/microsoft/mxc/blob/v1.0.1/docs/backends/process-container/os-version-support.md), [stable policy](https://github.com/microsoft/mxc/blob/v1.0.1/schemas/stable/mxc-config.schema.1.0.0.json), and [tier selection](https://github.com/microsoft/mxc/blob/v1.0.1/src/mxc-sdk/src/backends/process_container/common/fallback_detector.rs).

## Acceptance and current limits

Keep PR #224 Draft until real native Windows and packaged Agent checks succeed. Local macOS policy/configuration tests cannot qualify Windows behavior. Existing Windows native tests retain their assertions for NUL read/write, inherited/file/ignore/pipe child stdio, private user-only Node installation, argv fidelity, session writes, protected and foreign-Low write rejection, Job cleanup, and real pinned Kimi model/MCP/native-Bash/resume. Unsupported native capability is a failed acceptance result, not a planned skip.

The previous token backend reached JavaScript but denied NUL writes, failed `stdio: ignore`, hung creating pipes and timed out in real Kimi. The MXC implementation must pass those same tests; this change alone is not evidence that #225 is resolved. Standard-user operation, per-user packaged installation, linked-path attacks and complete cleanup still require actual Windows evidence.

Packaged Kimi smoke uses this production boundary, including source and executor materialization from the archive. The ordinary PR Desktop smoke does not call that Agent smoke; the latter currently runs in the release workflow. Neither desktop UI startup nor a source-only probe establishes packaged Agent qualification.

Windows `task-process.cjs::localCommand` remains a separate backend gap. Windows-to-deployed-service acceptance remains required per domain, including result downloads, Viewer presentation and consecutive sandbox auto-release. This PR does not close #223 or qualify all Windows industrial tasks.
