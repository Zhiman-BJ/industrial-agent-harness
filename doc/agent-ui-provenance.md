# Agent 聊天 UI 来源

实时 Agent 聊天区参考 [`Zhiman-BJ/eda-harness-demo`](https://github.com/Zhiman-BJ/eda-harness-demo) 中 `src/features/replay/ThinkingPreview.tsx`、`PlanTodo.tsx` 和 `ToolPreview.tsx` 的呈现方式。当前代码在 `apps/desktop/src/components/` 下，接收 `@moonshot-ai/kimi-agent-sdk@0.1.8` 的实时事件；没有引入轨迹回放引擎。

`ThinkingPreview.tsx` 和 `TodoList.tsx` 改编了对应组件的交互。工具、审批和状态在 `AgentFlow.tsx` 中通过实时事件展示。上游 demo 的模型配置是针对回放与 Live Agent 的已有流程；本项目的 `ModelSettings.tsx` 独立接入 Electron 设置与 Kimi CLI 配置。

Viewer 的代码来源单独记录在 [Viewer 代码来源](viewer-provenance.md)。

`examples/chip-sobel` 的七个源文件来自同一 demo 的 `demos/sobel/artifacts.tar.gz`。提取时根据 `manifest.json` 的路径与 SHA-256 校验，保留少量 RTL、测试、参考模型、约束和说明文件；它是文件工作区的示例目录，不代表完整可执行 EDA 工程。
