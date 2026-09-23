# Agent 聊天 UI 来源

实时 Agent 聊天区参考 [`Zhiman-BJ/eda-harness-demo`](https://github.com/Zhiman-BJ/eda-harness-demo) 中 `src/features/replay/ThinkingPreview.tsx`、`PlanTodo.tsx` 和 `ToolPreview.tsx` 的呈现方式。当前代码在 `apps/desktop/src/components/` 下，接收 `@moonshot-ai/kimi-agent-sdk@0.1.8` 的实时事件；没有引入轨迹回放引擎。

`ThinkingPreview.tsx` 和 `TodoList.tsx` 改编了对应组件的交互。工具、审批和状态在 `AgentFlow.tsx` 中通过实时事件展示。上游 demo 的模型配置是针对回放与 Live Agent 的已有流程；本项目的 `ModelSettings.tsx` 独立接入 Electron 设置与 Kimi CLI 配置。

Viewer 的代码来源单独记录在 [Viewer 代码来源](viewer-provenance.md)。

`examples/chip-sobel` 的七个源文件来自同一 demo 的 `demos/sobel/artifacts.tar.gz`。提取时根据 `manifest.json` 的路径与 SHA-256 校验，保留少量 RTL、测试、参考模型、约束和说明文件。`outputs/` 另取同一 Sobel 设计的最终网表、波形和版图，让文件树直接验证自动 Viewer 路由；它们是录制的产物，不代表精简源码目录本身可复现完整 EDA 流程。

| 项目产物 | 原 manifest SHA-256 |
| --- | --- |
| `outputs/sobel_netlist.json` | `eff43cc4f94307efbc3981fbc49c000d19b16192f8d7dafc77f3b92d820317b1` |
| `outputs/sobel_wave.vcd` | `da71356734959328ded9bc00845307d737735afb7071b392137ed9bfa45d52ad` |
| `outputs/sobel_layout.gds` | `88eb101db90f76a960f5b83e446423b7f8d66fa28240dc1110c49b6ceeabac95` |
