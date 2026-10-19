# Windows Agent process isolation candidate

Issue [#223](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/223) blocks Windows Agent startup even when industrial tools execute remotely. The Kimi process remains local. This candidate adds a Windows backend below the shared Kimi adapter; Desktop and CLI retain the same task API, Broker, approvals and remote Runtime.

## Boundary

The native helper uses a per-launch synthetic SID, write-restricted token and mandatory Low integrity. Only isolated session storage and scratch receive the corresponding write grants and Low labels. The project, canonical records and launcher/configuration stay outside those writable roots. The Agent still has ordinary host-file read access and TCP networking; this is a write boundary, not host-secret read isolation or network egress filtering. Host-only environment exclusions are preserved at final dispatch.

The helper opens the system-named noninteractive logon window station and creates a uniquely named, launch-secured desktop. Standard users cannot create an explicitly named window station. An existing logon station's ACL is not overwritten. Concurrent launches and preexisting logon-station permissions remain Windows acceptance cases. The Agent starts suspended, is assigned to a kill-on-close Job Object, then resumes. Only standard handles are inherited. Cancellation, server exit and host exit terminate descendants. The final token must pass nonmutating allowed-write and protected write/delete/WRITE_DAC/WRITE_OWNER access checks before launch.

Local fixed NTFS storage is required. Writable-tree reparse points and hard links are rejected before permission changes; native metadata operations use checked handles. Project instructions and Skills on Windows use bounded regular-file snapshots instead of links, while Kimi continues to own parsing, discovery, context and persistence. Engineering source stays in the project. Native `--add-dir` exposes the read-only project through absolute paths.

The helper source is original code using documented Windows APIs. It is read through Node (including from app.asar), materialized outside the writable roots, and compiled with the system .NET Framework 4 C# compiler. No compiler downloads, Docker installation or unsandboxed fallback are used. Missing dependencies or failed OS checks block startup.

Normal cleanup removes only the launch's SID grants, not whole ACLs. Low labels remain on session/scratch data. Force-killing the helper can leave unreachable random SID grants; persistent-session restart cleanup and long-running behavior require Windows acceptance. The project/system ACLs are not relabeled.

## Acceptance

The existing portable test discovery includes the new configuration, snapshot and Windows process tests. Native Windows tests exercise allowed/denied writes, foreign Low-integrity storage, linked-path rejection, argv fidelity, positive piped child execution, inherited restrictions, Job cleanup, real pinned Kimi model/host-tool/native-Bash communication and resume. Non-Windows execution emits an explicit diagnostic and does not qualify Windows behavior.

The packaged Kimi smoke now also uses the Windows production boundary, including helper source materialization from the application archive. Earlier Windows UI/packaging success started Kimi directly and was not acceptance of the production boundary.

Keep this candidate Draft until real Windows native and packaged checks succeed. [#225](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/225) reported standard-user window-station access denial and subsequent target-initialization/private-runtime failures on the original candidate; the administrator CI also timed out. This is a real startup failure, not platform qualification. The follow-up corrects the administrator-only station name and the token default DACL: the latter uses generic access for newly created kernel objects rather than incorrectly applying a file-Modify mask to process/thread objects. It does not grant access to existing host files or add Everyone/Users/logon/user SIDs to the restricting list. Inherited error mode suppresses invisible fatal-error dialogs, and stage/Win32/target-exit diagnostics distinguish startup failures from timeouts. These corrections must still pass Windows tests; they do not establish that every failure in #225 is solved.

Synthetic-only restricting SID compatibility with DLL/CNG initialization, TCP and named-pipe child startup remains an acceptance requirement. The native probe includes a copy of Node behind an actual user-and-SYSTEM-only directory ACL. Do not add broad restricting SIDs or remove the boundary just to pass startup. Compilation and Win32 API behavior must be verified by the Windows checks; local non-Windows tests cannot substitute for them. The ordinary PR Desktop smoke still does not call the packaged Agent smoke, which is currently run by the release workflow.

Native Windows `task-process.cjs::localCommand` remains a separate backend gap. True Windows-to-deployed-service acceptance is still required per domain, including result downloads, Viewer presentation and consecutive sandbox auto-release. This PR does not close #223 or qualify all Windows industrial tasks.
