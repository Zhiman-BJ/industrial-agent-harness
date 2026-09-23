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

工作台由桌面 UI、Kimi Code 接入、Industrial Capability Broker、工业运行时、Viewer 层和 Domain Packs 组成。Kimi Code 负责 Agent 会话与工具调用；Broker 根据项目状态和任务选择适用能力；工业运行时执行专业动作并记录产物与验证结果。Viewer 在工作台内展示适合直接查看的工程产物；对于 CAD、Godot 等复杂软件，重点展示关键产物，完整编辑仍在专业软件中完成。芯片和 PCB 将作为最早的参考领域。

目前的 MVP 已有可运行的 Electron 工作台：可查看 GDS/OAS 版图、Yosys JSON 网表及 VCD/FST/GHW 波形，输入工程任务并由 Capability Broker 按领域和阶段披露相关 Skill 与工具。Debug 模式展示 Broker 的 L0–L3 决策日志。Kimi Agent SDK 固定为 `0.1.8`；本机安装并登录 Kimi CLI 后，可选择工程目录，从界面启动会话。

```bash
pnpm install
pnpm --filter @industrial-agent-harness/desktop setup:layout
pnpm dev
```

版图 Viewer 需要 KLayout Python；也可通过 `KLAYOUT_PYTHON` 指向已有环境。执行 `pnpm build && pnpm start` 可运行构建后的桌面应用。现阶段桌面链路在 macOS 实测，Linux 与 Windows 发行包仍在开发中。

## 文档

从 [文档目录](doc/README.md) 开始阅读架构、Capability Broker、Viewer 层、领域扩展和开发阶段。仓库开发规则见 [AGENTS.md](AGENTS.md)。

项目参考了现有 [Silicon Lens demo](https://github.com/Zhiman-BJ/silicon-lens-harness) 和 [EDA Harness](https://github.com/Zhiman-BJ/eda-harness) 的实践。
