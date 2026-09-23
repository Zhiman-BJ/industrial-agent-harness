# 架构决策记录

本页区分当前已确定的方向、两份计划中的建议和仍需实测的接口。计划材料是设计输入，不是对现有实现的描述。

## 已确定

| 决定 | 当前落实情况 |
| --- | --- |
| Electron 桌面端面向 Linux、macOS、Windows | macOS 桌面 MVP 已运行；三平台打包尚未验证 |
| 第一阶段使用 Kimi Code，不自研 Coding Agent | `packages/agent-kimi` 精确依赖官方 SDK `0.1.8` 并接入桌面；本机无 Kimi CLI，真实会话尚未验证 |
| Kimi 接入尽量非侵入 | 不把上游整仓作为 submodule；优先使用公开接口 |
| Monorepo 分离 UI、领域 Skill、领域 Runtime、MCP 等职责 | UI、Viewer、Broker、Kimi 和首批 Skill 声明已实现；Runtime/MCP 仍是边界模块 |
| Skill 和 Domain MCP 均采用渐进式披露 | Broker 已披露 Skill 和 Tool Scope；Kimi 外部工具按 Scope 注册。独立 Domain MCP 服务尚未接入 |
| 产品支持多个工业场景，首批以 Chip 和 PCB 验证 | 有 Chip/PCB 首批 Capability 声明；PCB 真实工具尚未接入 |
| 建立独立 Viewer 层 | KLayout、netlistsvg、Surfer 三组 Viewer 位于正式产品路径并已接入桌面 MVP |

## 两份提案的差异及当前取舍

- **Agent 适配**：Broker Plan 描述可替换的通用 `AgentRuntimeAdapter`；架构 Plan 明确第一阶段专精 Kimi。当前选择 Kimi 专属 Integration，不以假定通用性压缩 Kimi 原生能力。工业契约保持独立，为未来新接入留出边界。
- **Broker 与控制面**：Broker Plan 建议独立本地 Sidecar；架构 Plan 描述包含 Broker 职责的 Harness Daemon。先分清逻辑职责，进程部署形态由跨平台生命周期与故障隔离测试决定。
- **MCP Gateway 时序**：架构 Plan 建议统一 Gateway；Broker Plan 允许 V1 先直连现有 MCP，后续整合。首版必须验证受控 Tool Scope 和渐进式披露；是否先用直连方式由 SDK 能力与集成复杂度决定。
- **发布包**：两份材料都设想随桌面应用安装 Kimi 和 Broker。当前只固定 Node SDK 版本；Kimi 可执行运行时的版本、来源、校验和许可仍需单独决策。

## 待验证问题

1. SDK `0.1.8` 与当前 Kimi Code 运行时能否满足会话、事件、审批、中断和恢复要求？
2. 能否在不修改 Kimi 核心的情况下按会话更新 Skill Batch 与 MCP Tool Scope？生效时点与撤销语义是什么？
3. 本地控制面、Broker、Gateway 与 Kimi 分进程或同进程时，哪种形态更可靠且便于三平台打包？
4. Domain Pack 的 schema、安装格式、资源校验和版本兼容边界如何冻结？
5. 芯片与 PCB 的首批真实动作分别由哪个工具和验证器承担？
6. 各领域哪些格式适合内置渲染？首批解析器的许可证、性能和跨平台限制是什么？

上述问题应先通过探针、契约测试和真实流程记录结论，再将提案升级为正式 ADR。
