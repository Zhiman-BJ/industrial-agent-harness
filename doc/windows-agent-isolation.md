# Windows Agent execution with current user permissions

[PD-086](product-decisions.md#pd-086windows-使用当前用户权限运行-kimi) supersedes the MXC candidate in PD-085. Windows starts the original Kimi with the current user's ordinary permissions. It does not require MXC, Windows PSEC, feature flags, administrator setup, NTFS-only isolation checks, or the .NET compiler. macOS Seatbelt and Linux bubblewrap/seccomp retain their existing protected paths.

## Launch and permissions

The shared Agent adapter prepares a persistent session workspace and temporary scratch directory, then launches Kimi directly with `shell:false` and explicit arguments/environment. No restricted token or C# launcher is used. Session storage may be nested under Harness settings. The engineering project and session storage must still be separate to avoid confusing generated session files with project inputs.

Windows reports `mechanism: windows-current-user`, `osIsolation: false`, and `projectWritable: true`. The model context identifies the actual project and session paths without promising a read-only project. This execution profile has a separate context compatibility key, so earlier protected-profile conversations are not silently reused under different permissions.

**Native Bash, file tools and descendant processes can modify anything the current Windows account can modify, including project files, Harness state and configuration.** Working directories, copied inputs, explicit environment filtering and approvals are not an OS write boundary. No secret-read, network or arbitrary-code isolation is claimed. Host-only environment names are filtered without regard to case, including at final dispatch; that does not prevent reading credentials from files accessible to the user.

Industrial tool calls still go through the existing Broker allowlist, approval and Runtime checks. Remote industrial sandboxes retain their own authentication, storage, resource limits, result handling and release lifecycle. Removing local MXC does not remove those checks, but they do not intercept local native file operations.

## Lifecycle

Session close first requests Kimi's native shutdown through the existing adapter. Force cancellation of a live process uses Windows `taskkill /PID <pid> /T /F`, with direct root-process termination as a fallback. Temporary scratch is removed after owned child streams close; persistent conversation storage is retained. This is best-effort process cleanup, not Job Object ownership. Abrupt host exit or descendants surviving an already-exited root do not have the earlier candidate's Job cleanup guarantee.

## Verification

`windows-process-sandbox.test.cjs` now verifies the user-authorized current-user profile: NUL read/write and inherited/file/ignore/pipe stdio, private user-only Node execution, literal argv, filtered environment, ordinary project/state writes, live-tree cancellation, and pinned Kimi model/MCP/Bash/resume. The former OS write-denial and Job Object assertions are removed because PD-086 explicitly changes that contract; they are not reported as passing isolation tests. Platform configuration and snapshot tests also cover nested settings/session storage and no false isolation claim.

A successful source or controlled-model test is not evidence for all deployed domains or the packaged application. Packaged Agent startup, Windows-to-service tool calls, result downloads, Viewer presentation and consecutive sandbox release still need real acceptance. No workflow, checker or architecture-policy exception is changed by this execution-profile revision.
