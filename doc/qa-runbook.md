# QA 测试用例与自动执行手册

这是 Coding/QA Agent 的兼容执行入口。完整验收按 **[执行协议](qa-runbook/protocol.md) → [T0–T6 分层命令](qa-runbook/tiers.md) → [产品模块矩阵](qa-runbook/modules.md)** 进行；定向模块检查不能替代分层门禁。

2026-10-18 核对基线：main 的 `4e8cc44`，加本审查分支的模态焦点、布局、展示性能与恢复回归补丁（`3b6d907`、`b610dbc`）；本分支 Harness 修复尚未发布。页面中的“覆盖”指源码与 workflow 已存在的测试，不是本次执行结果。实际 SHA、dirty 快照、结果与证据必须按协议另记。未合并 PR／远程分支不作为已交付能力；#209 见[诊断与打包](qa-runbook/diagnostics-packaging.md)。

本轮问题统一跟踪于 [issue #219](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/219)。Owner PR #48 最终候选的 CI 与本地历史失败、原生阻塞、旧 Harness pin 分开记录，见[候选 Pack 验收](qa-runbook/domains-resources-mcp.md)和[审查报告](reviews/main-review-2026-10-18.md)；npm audit 新提示两项（1 moderate、1 high）仍待分诊，未作为已修复或验收通过。

| 入口                                            | 用途                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| [执行协议、判定与证据](qa-runbook/protocol.md)  | 完整 SHA 锚定、依赖身份、suite 锁、fail-fast、报告、skip/flake 与先预览后清理          |
| [T0–T6 分层命令与 CI 对照](qa-runbook/tiers.md) | 前置条件、静态／portable／桌面／transport／native／打包／Linux 安装器、DoD 与 workflow |
| [产品模块验收矩阵](qa-runbook/modules.md)       | 按近期模块选择步骤、边界、失败恢复、证据与自动覆盖缺口                                 |

模块页：[工作台、项目与聊天](qa-runbook/workbench-project-chat.md) · [模型与账号](qa-runbook/models-account.md) · [领域安装、资源与 MCP](qa-runbook/domains-resources-mcp.md) · [远程执行](qa-runbook/remote-execution.md) · [Viewer 与成果](qa-runbook/viewers-results.md) · [诊断与打包](qa-runbook/diagnostics-packaging.md) · [性能、崩溃与恢复](qa-runbook/performance-recovery.md)。

完成标准见 [Definition of Done](04-definition-of-done-and-architecture-tests.md)，职责见 [IH-ARCH-001](architecture-contract.md)，托管平台见 [CI 回归](ci-regression.md)，交互依据见[产品决策](product-decisions.md)。本次拆分不改变产品决定、工业契约、架构例外或平台支持声明。
