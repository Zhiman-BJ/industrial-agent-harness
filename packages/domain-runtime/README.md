# Domain runtime

2026-10-16 gateway compatibility work (not yet a Desktop/CLI integration):
`RemoteGatewayClient.uploadSnapshot` implements manifest → per-object PUT → complete;
`callProtectedTool` uses the shipped `requestId/snapshotId/expectedStateId` envelope;
`downloadProducedArtifact` reads the current download route and validates recorded hashes.
MCP resolves the account-bound credential provider on every HTTP request, including an
existing transport. Unknown mutations are not automatically replayed. Upload targets
must belong to the bound gateway/project/snapshot and match approved content hashes.

The existing canonical `RemoteRuntime` still consumes the historical state/capabilities/
grant/result contract. The production response observed in the 2026-10-16 live test
contains verification/artifacts but `state: null` and no run/action/checkpoint. These
client methods deliberately do not manufacture those facts or claim a successful
Workbench task. Shared Runtime integration and a real authenticated desktop run remain
required. Contract tests use an in-memory HTTP fixture, not a real remote sandbox.

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

`RemoteRuntime` 保持规范 Runtime 接口，通过认证服务 0.2 控制协议提交已批准的快照操作、查询/取消持久任务并验证回读事实。服务事实保留原身份，产物经摘要校验进入本地 CAS；执行完成与工程通过分开。远程模式不启动本地领域 MCP 或声明任务。`IndustrialRuntime` 可由可信宿主传入已绑定的规范 `projectRef`，不由模型指定。见[内置远程运行](../../doc/remote-execution.md)。

The public module exposes `executeTask` and `runtimeFiles` for trusted owner plugins injected through the shared factory. Protected task lifecycle stays in this backend. Multi-phase native actions can reuse their per-action HOME/TMPDIR; creating those bounded directories is idempotent.

Optional producer `presentation` metadata binds only local names from the actual collected output set. Replacement/check inputs require recorded input hashes or a staged snapshot matching actual project bytes. Invalid display metadata yields diagnostics and cannot alter Action/Artifact/Verification facts. The generic file writer declares only explicitly changed nondeleted outputs. [Result contract](../../doc/task-results.md).
