# 文档目录

这里记录 Industrial Agent Harness 的产品架构与开发计划。桌面 MVP、三种内置 EDA Viewer、确定性 Broker 和 Kimi SDK 接口已落地；完整 Domain Runtime、Domain MCP、真实工业动作及三平台发行包仍在开发中。文档中的其余接口与验收项，除明确标为“已落实”的事项外，均为设计提案。

| 文档 | 内容 |
| --- | --- |
| [系统架构](architecture.md) | Kimi Code、桌面端、Broker、工业运行时与领域包的职责和数据流 |
| [Capability Broker](capability-broker.md) | Capability 解析、skill 与 MCP 工具的渐进式披露、Scope 和 Trace |
| [Viewer 层](viewer-layer.md) | 内置查看、关键产物预览、外部打开与证据边界 |
| [Domain Pack](domain-pack.md) | 芯片与 PCB 等领域的扩展方式和最小契约 |
| [开发计划](development-plan.md) | 阶段顺序、首批验收场景、验证方法与待确认问题 |
| [产品决策记录](product-decisions.md) | 已确认的用户交互与项目模型决定，包括 Project、目录、Domain 和 Session 的关系 |
| [架构决策记录](decisions.md) | 已确定的决定、提案间的差异和需要验证的接口 |
| [CLI 与 Bench 入口](../apps/cli/README.md) | 无界面单任务命令、JSON Lines 事件、模型与工件输入 |
| [Agent 聊天 UI 来源](agent-ui-provenance.md) | EDA Harness demo 的思考、Todo、工具呈现如何接入实时 SDK 事件 |

来源：用户提供的《Industrial Harness 架构与开发 Plan》（2026-09-23，v0.1 提案）和《Industrial Capability Broker 开发 Plan》。本目录提炼两份材料供仓库实施使用，不把计划中的示例接口当成已经存在的实现。
