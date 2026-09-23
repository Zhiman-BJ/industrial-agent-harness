# Industrial Agent Harness

Industrial Agent Harness 是面向工业设计与工程任务的桌面工作台。它把 AI 协作、专业软件、项目状态和可核验的工程结果连接起来，让用户能在同一处提出目标、执行工作、查看产物，并理解结果是否满足要求。

项目从芯片设计和 PCB 设计起步，架构面向更多工业场景扩展，例如机械 CAD、CAE 仿真和其他依赖专业工具与验证流程的领域。每个领域以独立的 Domain Pack 提供能力、知识、工具、查看方式和验证方法；工作台保持一致的交互体验。

## 产品目标

- 在 Linux、macOS 和 Windows 上提供统一的 Electron 桌面体验。
- 让用户围绕真实项目与产物协作：从当前状态出发，选择能力、执行动作、检查结果，再继续下一步。
- 把芯片、PCB 等领域的专业工作流接入同一个平台，同时允许领域能力独立扩展。
- 让 Agent 按当前任务获取相关知识与工具，使大量领域能力仍然易于发现和使用。
- 保留工程过程与结果的关联，方便查看、复现、比较和后续评估。

## 项目组成

工作台由桌面 UI、Kimi Code 接入、Industrial Capability Broker、工业运行时和 Domain Packs 组成。Kimi Code 负责 Agent 会话与工具调用；Broker 根据项目状态和任务选择适用能力；工业运行时执行专业动作并记录产物与验证结果。芯片和 PCB 将作为最早的参考领域。

当前仓库处于架构与工程骨架阶段，尚无可运行的桌面应用。Kimi Agent SDK 已固定为 `0.1.8`；具体接入和跨平台打包仍在后续开发范围内。

## 文档

从 [文档目录](doc/README.md) 开始阅读架构、Capability Broker、领域扩展和开发阶段。仓库开发规则见 [AGENTS.md](AGENTS.md)。

项目参考了现有 [Silicon Lens demo](https://github.com/Zhiman-BJ/silicon-lens-harness) 和 [EDA Harness](https://github.com/Zhiman-BJ/eda-harness) 的实践。
