# 27B / 256k 上下文适配计划

状态：2026-09-25，本 PR 的上下文适配、诊断日志、只读状态续接及真实模型评测已实施。完整工业 Action/Verifier Vertical Slice 仍由[现有 Core 路线图](03-implementation-roadmap.md)负责，不能用本 PR 的文件观察代替。

## 目标与边界

27B 模型的 256k 窗口提供容量，但不保证长历史中每条工程信息都能被稳定利用。Harness 负责减少自身注入的噪声、保存可重新取得的工程观察和完整调试日志；固定的 Kimi Agent SDK `0.1.8` 与 Kimi CLI `1.51.0` 继续负责工具循环、会话历史和上下文压缩。

当前可确认的工程事实只有已登记项目文件的路径、大小与重新核验的 SHA-256。它们的验证状态始终为 `not_run`。用户提示和模型摘要不生成 DomainState 或工程验收结果。

## 实施步骤与验收

1. **控制模型侧输入**：Harness 外部工具 JSON 返回上限为 16 KiB，Industrial Context 上限为 8 KiB；能力详情支持分段读取。超限明确失败，不将截断内容伪装成完整事实。界面另行截断显示时标明原始字节数。
2. **保留有用的会话**：以 domain、stage、capability、skill、tool 的有效 Scope 判定复用；随机 Scope 版本更新不会重建 Kimi 会话。有效 Scope 或模型配置变化仍新建会话，每轮重新注入当前 Scope。
3. **持久化文件观察锚点**：CLI 与桌面端共用 SQLite 观察状态；在每轮提示前核验登记文件哈希，建立最小 Checkpoint。只注入短锚点，`industrial_context_read` 可按页读取历史记录。Scope 重建和进程重启后仍可取回；旧记录明确标为历史观察，不冒充当前验证。
4. **完整诊断日志**：每轮用 Trace ID 保存 Broker 决策、实际 SDK 提示、SDK 暴露的所有原始事件、完整工具返回、审批、压缩、占用统计及结果，同时保存固定 Kimi CLI 的上下文与 Wire 快照。CLI 和桌面 Debug 模式显示路径。目录 `0700`、文件 `0600`；已知模型凭据脱敏。日志可能包含用户任务和工程数据，应按项目资料管理。
5. **真实模型评测**：用用户提供的 Qwen 27B 服务测试标准工具调用、SDK 外部工具、自动压缩后的 Checkpoint 取回，并对约 8k 至 255k 实际输入 token 做开头／中段／末尾的合成工件检索。保存不含密钥的汇总与可复现脚本，见[评测记录](27b-evaluation-results.md)。

## 判定结果

- 单元、CLI 打包、架构门禁和桌面构建通过；真实 SDK 会话完成外部工具调用，并在一次自动压缩后通过 `industrial_context_read` 找回工件哈希。
- 合成检索通过至 255,204 个实际输入 token；该结果仅证明这些合成样例，不能推导复杂工程任务的总体成功率。
- 当前没有证据需要 fork 或改写 Kimi 的压缩算法。保留真实长任务回归和失败样例作为后续调参依据。
- 完整 DomainState、Run、Action、Artifact、Verification 与工程 Checkpoint 的持久化链尚未建立；只读观察存储不满足 Industrial Core Vertical Slice 的验收 Gate。
