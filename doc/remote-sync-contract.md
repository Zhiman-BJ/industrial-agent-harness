# 远程沙箱同步契约（P0 冻结）

2026-10-15：本文件冻结 issue
[#199](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/199) P0
阶段的 Harness 侧契约。这些 schema、枚举与状态转移是**版本化设计契约**；
它们的存在不证明任何服务端点已部署或任何领域工具已通过远程验收。
`REMOTE_SCHEMA_VERSION` 为字符串 `'1'`，独立于旧 0.2 job 协议和
`INDUSTRIAL_SCHEMA_VERSION`；客户端当前实现的协议版本为
`REMOTE_PROTOCOL_VERSION = '1.1'`（#134 会话式接入 lineage）。

## 基线核对（2026-10-15）

- Harness main：`e0bc4c4`（issue 记录的 `28199b3` 之后合入了 #198）。
- PR #134（会话式 MCP / protected v1.1 接入）：仍 OPEN，base 为
  `codex/pcb-managed-runtime-20261012`，未进入 main。本契约不依赖其合入。
- 配套服务端 industrial-harness-remote#14：本次无法从客户端账号核对部署
  commit 与 capabilities；远程资格以运行时 `service-info` 的
  `qualifiedProfiles` 为准，不以文档或目录列表为准。
- #189（账号隔离）：仍 OPEN。契约层的承接方式是严格 schema 拒绝令牌字段
  （见下文负向测试），不复制其运行时修复。

## 契约清单（`packages/contracts/src/remote.cjs`）

| 导出 | 语义 |
| --- | --- |
| `RemoteServiceInfoSchema` | service-info：区分 `protocolVersion`、`contractsVersion` 与 `features`，固定 `serverId`、服务名与部署 commit、转移/恢复能力及已验收 profile 列表 |
| `REMOTE_PROTOCOL_FEATURES` / `RemoteFeatureFlagsSchema` | 冻结的 feature flag 全集：`upload-sessions`、`source-changesets`、`invocation-recovery`、`artifact-bundles`、`workspace-lease`、`sync-ack`；缺项由 `missingRemoteFeatures` 明确列出，不静默回退 |
| `RemoteProfileQualificationSchema` | 服务报告的实际 profile：runtime family + digest、native 版本、逐工具可用性与原因、验收时间 |
| `PackExecutionProfileSchema` | Pack 声明：pack ID/版本/digest、Core 兼容范围、复用 canonical `ToolDescriptorSchema` 的工具身份、支持的 remote profile 列表 |
| `negotiateRemoteProfile` | Pack 声明与服务资格的**交集**；服务目录中 Pack 未声明的工具（如 `shell.exec`）不进入可用集合，未报告/不可用工具带原因 |
| `WorkspacePolicySchema` / `ToolMutationPolicySchema` / `ToolResultPolicySchema` | Pack 的输入闭包与路径参数重写范围、逐工具 mutation 效果与事务组、collector/presentation/完整性策略；不以后缀猜测 |
| `RemoteSnapshotManifestSchema` / `RemoteUploadSessionSchema` | 版本化输入 manifest（路径排序唯一）与上传会话（只传缺失 blob、按 digest 去重、带过期时间） |
| `SourceChangeSetSchema` | 一次 Action 的源工程变更：base/output 快照、invocation/action 关联、add/modify/delete/rename 逐路径前后 hash+size、依赖组；rename 保持内容（改名加内容变更必须建模为 delete+add） |
| `RemoteArtifactBundleSchema` | 不可变成果包：复用 canonical `ArtifactRefSchema` 与 `ActionPresentationSchema`，强制 bundle/action/project 身份一致 |
| `RemoteInvocationRecordSchema` | 发送前持久化的调用身份：invocationId、输入快照、expectedStateId、能力 hash、意图摘要 hash、grant 身份与状态 |
| `RemoteSyncStateSchema` / `SYNC_TRANSITIONS` / `reduceSyncState` | 同步协调器状态机（见下）；只描述同步，不改写 canonical Run/Verification 结论 |
| `RemoteSessionBindingSchema` | 持久绑定：service origin/serverId + principal + 本地↔远端项目 + domain + chat + clientSessionId/applicationSessionId + profile + applied snapshot；三种身份互不混用 |

## 同步状态机（issue §5.2）

```text
PREPARED --dispatch--> DISPATCHED --remote-committed--> REMOTE_COMMITTED
REMOTE_COMMITTED --apply-started--> LOCAL_APPLYING --apply-completed--> READY
REMOTE_COMMITTED --no-source-change--> READY   （只读/纯产物调用跳过本地应用）
PREPARED|DISPATCHED --rejected--> NOT_SUBMITTED --retry--> PREPARED
DISPATCHED --outcome-lost--> OUTCOME_UNKNOWN
OUTCOME_UNKNOWN --outcome-committed--> REMOTE_COMMITTED
OUTCOME_UNKNOWN --outcome-not-submitted--> NOT_SUBMITTED
LOCAL_APPLYING --apply-conflict--> CONFLICT
LOCAL_APPLYING --apply-crashed--> RECOVERY_REQUIRED --resume-apply--> LOCAL_APPLYING
RECOVERY_REQUIRED --apply-conflict--> CONFLICT
READY / CONFLICT 为终态。
```

规则要点（由测试固化）：

- `OUTCOME_UNKNOWN` 只按原 invocationId 只读查询恢复，绝不以新 invocation 重放。
- `READY` 仅表示同步条件满足，不表示工程 verification 通过。
- 带 changeSet 的 `READY` 必须记录 `appliedSnapshotId`；changeSet 必须属于某个
  output 快照。
- 转移表覆盖且仅覆盖 `SYNC_STATES`/`SYNC_EVENTS` 中声明的值，非法转移抛出。

## 安全不变量（契约层负向测试）

- 所有 schema 均为 strict：`token` / `credential` / `authorization` 等字段在
  service info、invocation、binding 中一律被拒绝；令牌不进入 manifest 或
  journal（承接 #189 的账号隔离方向，运行时修复仍以 #189 为准）。
- `RemoteSessionBindingSchema` 的 service origin 复用现有规则：仅 HTTPS
  （开发允许 loopback HTTP），拒绝 userinfo/query/hash/路径。
- 路径一律为项目相对 POSIX 路径；拒绝 `..`、绝对路径、盘符、反斜杠与空段。
- 未知 schema 版本被拒绝，不做自动降级。

## 验证

```sh
node --test packages/contracts/tests/remote-contract.test.cjs
node scripts/check-pack-release.cjs   # 含 consumer-types.cts 类型检查
```

## 边界

本阶段只冻结契约与纯函数（特性协商、状态转移）。消费方（#134 会话客户端的
演进、WorkspaceSync、RemoteExecutionCoordinator、ArtifactContentResolver）
在 P1/P2 落地并各自验收；服务端相应能力以 industrial-harness-remote 的实际
部署与 qualification 为准。契约不等于能力：连接成功、文档版本字符串或目录
中列出工具都不是原生执行资格。
