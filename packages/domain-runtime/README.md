# Domain runtime

2026-10-20 input binding: declared workspace tasks hash-check their manifest,
copy exact inputs, and recheck the copies after execution. Only an Action-bound,
in-process snapshot result preserves its historical verifier verdict across
concurrent live-source edits; other producers keep the conservative
insufficient-evidence path. `createEvidenceInspector` supplies bounded read-only
observations for application results without changing canonical records.
Matching recorded files is not whole-project acceptance or full-source restore.
See [scope and limits](../../doc/evidence-input-binding.md).

2026-10-16 current MCP gateway integration: the shared factory selects the current
adapter from the persisted service contract. It uses manifest/object/complete uploads,
per-request credentials and the protected `requestId/snapshotId/expectedStateId` call.
The same adapter is consumed by Desktop and CLI. Harness creates its own canonical
Run/Action/Checkpoint records; the remote response is retained as a separately
attributed receipt under `remote-receipts`. Local input hashes come from the approved
snapshot. A null remote state does not create a domain stage. Downloaded outputs are
hash-checked before import; `remote.reported` records the server verifier assessment
and retains the original verifier identity in the receipt and explanation.

The new adapter never calls the retired state/capabilities/grants/invocations routes.
Unknown outcomes block later mutations instead of triggering a replay. The current
service has no read-only invocation lookup, so unknown-result reconciliation and
resuming an interrupted artifact import still require operator handling. Artifact
browsing lists only results recorded by this client, not all remote project history.
Transport close does not terminate the application session or its sandbox.

The 2026-10-17 reliability fix carries cancellation through asynchronous discovery
and rechecks it before starting a workspace action. Once a request was submitted,
Stop still only ends the local wait; its unknown outcome cannot be replayed.
`needsImport` stays set until the matching local Run/Action/Verification/Checkpoint
has committed through the Runtime, including a legitimate remote verification
failure. Collection or transaction failures retain that flag and the source receipt.
Pending imports block execution across chats, upload/rebind/location changes and
service replacement, including after reopen. A second check after discovery closes
the race with another chat's failed import. Desktop reports that results need recovery
and disables execution. Recovery of incomplete imports still requires operator handling.

The in-memory contract suite exercises upload, Broker/approval boundaries, persistent
records, reopen, corruption and disconnect handling. `scripts/verify-current-remote-gateway.cjs`
is an opt-in live diagnostic through settings, Broker and Runtime; it does not perform
model inference. The real 2026-10-16 Chip run, source verifier result, downloaded artifacts
and local record reopen are recorded in [deployment evidence](../../doc/evidence/remote-gateway-20261016/README.md).
That diagnostic did not use a model. A separate 2026-10-17 real Desktop conversation
with MiniMax-M3 and Kimi Code 2.1.1 exercised the same shared Runtime: the model's
approved `chip.rtl.verify` call completed in a fresh remote sandbox lease, the source
verifier passed, and the model read this run's report and finished its reply.
Reopened records and all three artifact hashes matched. See the
[conversation evidence and limits](../../doc/evidence/remote-chat-20261017/README.md).
These cases do not qualify other domains or CLI live model execution.

Owns deterministic domain execution, run state, evidence, and artifact provenance. It must not depend on Electron, Kimi, or the MCP transport.

当前已实现 `ObservedContextStore`：CLI 与桌面端按 Project/Domain 在用户数据目录保存 SQLite 工件文件观察与最小 Checkpoint。每次提供给模型前重新核对文件路径与 SHA-256；历史 Checkpoint 仍可分页读取。记录明确标为 `verificationStatus: not_run`，不能代表工程通过。

`ActionJournal` 为已有原生工具调用保存 Run/Action 身份、实际输入、诊断及显式工件集合。它继续保持 `not_run`；仅有进程退出不能建立工程验收。

`IndustrialRuntime` 提供 schemaVersion `1` 的持久 Project、DomainState、Run、Action、Artifact、Verification 与 Checkpoint。注入的 Pack StateProvider 读取实际输入摘要；`execute({toolId,inputs,expectedStateId},{scope,approval})` 在执行边界重查项目、领域、Broker 范围、当前 State 与审批。结果包括 `{run,action,artifacts,verification,state,checkpoint}`，CLI/Desktop 使用同一 Factory/Runtime。拒绝、失败与中断均保留诊断、显式产物集和不足证据结果。

SQLite 原子提交规范记录与 State/Checkpoint head；产物进入 SHA-256 内容存储，读取再次验证。输入变化使当前 State 失效为 `stale`，历史验收和产物仍可查询；不修改过去的事实。一个项目同时只能由一个 Runtime 拥有；存活租约拒绝重开，死亡租约将未完成 Action 恢复为失败。`cancel()` 请求 Pack 原生取消，`waitForIdle()` 等待其实际清理，不能通过杀死模型进程假定工业工具也已停止。

`IndustrialRuntime.openRecords(projectDir, domain, {directory, projectRef})` 以只读 SQLite 连接查询已有规范记录，返回绑定的 Project、`get` 和 `close`；未建库时返回 null，不创建目录或数据库。它不加载 Pack、不获取执行租约、不恢复未完成 Action，可在执行 Runtime 存活时读取，也可在关闭后读取历史；项目绑定及数据库版本不匹配会明确拒绝。

已行使的首条闭环是 Chip Pack 的 RTL lint/Verilator assertion simulation、真实 VCD、独立证据检查以及重启恢复。每个 Tool 当前要求一个汇总 Verifier，避免忽略其他验证器。其他领域仍使用各自已有运行时，不因此成为规范 Core 闭环。原生工具/容器清理由现有 EDA Runtime 负责。实际支持和限制见 [P0 工业运行时](../../doc/p0-industrial-runtime.md) 与 [安全边界](../../SECURITY.md)。

Runtime Tool 可携带输入指南，通过受 Scope 约束的 `describeTool` 按需披露；这属于工具文档，不生成工业事实。FreeCAD 原生 Pack 复用执行、产物、回读验证与持久化路径，见 [FreeCAD 接入](../../doc/freecad-domain-pack.md)。

Read-only host Tools still enter `IndustrialRuntime.execute` with the current project, Broker Scope and State identity. Their Actions, diagnostics and Checkpoints are persisted, but successful or failed observations do not replace the engineering State, artifacts or verification identities. Readiness is separate from engineering acceptance.

createWorkspacePlugin 提供所有领域共用的初始化、受控文件读写和声明任务执行。effect=inputs 的编辑回执保留旧验收并标 stale；effect=external 记录宿主服务 Action 与未验收响应而不替换工程 State。执行只有明确 checks-json 才能通过，退出码不能单独建立验收。格式、限额和真实消费者回归见[共享工程底座](../../doc/shared-workspace.md)。

`doctor --project-dir DIR --domain DOMAIN` runs without model credentials and records a read-only environment Action. It probes protected local execution, declared executables/dependency roots and available offline Docker images. Exit 2 means a required prerequisite is missing. Shared tools include `project.environment.inspect`; input selection, local read permissions and approval previews are documented in [Shared workspace](../../doc/shared-workspace.md).

The protected execution probe uses a fixed native shell command, independent of
the application's Node or Electron executable. Local macOS app executables receive
read-only access to their canonical `Contents` installation, including frameworks
and resources, without exposing adjacent apps. Installations overlapping the source
project require explicit dependency grants. Reusing the current Electron runtime
sets Node mode inside the backend; arbitrary host environment variables remain
filtered. Readiness is distinct from task verification.

Automatic runtime-directory grants compare physical directory identities and
ancestors, including project overlaps and excluded shared prefixes. Case aliases
on macOS cannot widen those grants; distinct directories on case-sensitive volumes
remain distinct. If a required directory identity cannot be established, the task
stops before launch rather than granting an unchecked directory.

`RemoteRuntime` 保持规范 Runtime 接口，并按持久服务契约选择历史 canonical gateway 或当前 MCP adapter。当前 adapter 的行为和限制见本页开头；不再使用 0.2 job 协议。远程模式不启动本地领域 MCP 或声明任务。`IndustrialRuntime` 可由可信宿主传入已绑定的规范 `projectRef`，不由模型指定。见[内置远程运行](../../doc/remote-execution.md)。

The public module exposes `executeTask` and `runtimeFiles` for trusted owner plugins injected through the shared factory. Protected task lifecycle stays in this backend. Multi-phase native actions can reuse their per-action HOME/TMPDIR; creating those bounded directories is idempotent.

`dockerCli` exposes the shared docker CLI discovery used by doctor, container tasks and image installation: the PATH first, then well-known installs (Docker Desktop's `~/.docker/bin`, `/usr/local/bin`, Homebrew, the Docker.app bundle, per-platform Windows locations), then a timeout-bounded login-shell PATH capture for GUI-launched processes whose environment lacks all of them.

Optional producer `presentation` metadata binds only local names from the actual collected output set. Replacement/check inputs require recorded input hashes or a staged snapshot matching actual project bytes. Invalid display metadata yields diagnostics and cannot alter Action/Artifact/Verification facts. The generic file writer declares only explicitly changed nondeleted outputs. [Result contract](../../doc/task-results.md).
