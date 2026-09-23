# Industrial Agent Harness

面向工业领域任务的跨平台 Agent 工作台。项目从现有 Silicon Lens Electron demo 与 EDA Harness 的经验出发，建立独立的 monorepo；当前仓库是架构骨架，尚无可运行应用。

## 已确定的边界

- 桌面端采用 Electron，目标平台为 Linux、macOS、Windows。
- 底层 coding agent 使用 `kimicode-sdk`。本仓库只实现接入适配，不另造 agent loop；优先使用公开接口，避免修改或 fork SDK。
- UI、domain skill、domain runtime、domain MCP 分层维护。跨层数据通过共享契约传递，不让 UI 直接依赖领域工具实现。
- domain skill 与 domain MCP 必须渐进式披露：先给出简短能力索引，按任务需要再加载具体说明、参数 schema 与工具；不能在启动时把全部领域知识和工具定义注入模型上下文。
- 领域执行结果应保留输入、运行、产物和验证证据；进程成功退出本身不等于任务验收通过。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 主进程、preload、安全 IPC 和 UI |
| `packages/agent-kimi` | `kimicode-sdk` 的薄适配、会话与事件映射 |
| `packages/contracts` | 模块间共享的数据与事件契约 |
| `packages/domain-skills` | 领域 skill 索引、按需加载与版本管理 |
| `packages/domain-runtime` | 确定性任务执行、状态、证据与产物管理 |
| `packages/domain-mcp` | 领域能力发现与 MCP 接口，按需披露工具 |
| `.github` | 仓库协作模板和基础检查 |

依赖方向：`desktop → contracts / agent-kimi / domain-mcp`；`domain-mcp → contracts / domain-runtime`；`domain-skills → contracts`。`domain-runtime` 不依赖 Electron、Kimi 或 MCP。具体接口在实现时以契约测试确定。

## 渐进式披露约定

1. **发现**：只返回领域、能力名称、简短用途和稳定标识。
2. **展开**：选中能力后读取相应 skill 内容、适用条件和工具 schema。
3. **执行**：仅将本次任务需要的工具接入会话；返回有界结果和证据引用，大型产物单独读取。

发现、展开和执行都应受项目上下文与权限边界约束。skill 文本提供指导，实际执行与验收以 runtime 记录为准。

## 当前状态与下一步

此提交只建立仓库和模块边界。下一步先验证 `kimicode-sdk` 的会话、流式事件、工具/MCP 注册、审批、中断和恢复接口，再实现一条最小的端到端链路。目标平台的打包与真实领域流程需要分别验证。

参考项目：[Silicon Lens demo](https://github.com/Zhiman-BJ/silicon-lens-harness)、[EDA Harness](https://github.com/Zhiman-BJ/eda-harness)。这两个仓库的代码与产物没有复制进来。
