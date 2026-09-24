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

工作台由桌面 UI、无界面 CLI、Kimi Code 接入、Industrial Capability Broker、工业运行时、Viewer 层和 Domain Packs 组成。桌面 UI 面向交互使用，CLI 面向 Domain Task bench；两者共用无界面的能力解析与 Agent 接入。Kimi Code 负责 Agent 会话与工具调用；Broker 根据项目状态和任务选择适用能力；工业运行时执行专业动作并记录产物与验证结果。Viewer 在工作台内展示适合直接查看的工程产物；对于 CAD、Godot 等复杂软件，重点展示关键产物，完整编辑仍在专业软件中完成。芯片和 PCB 将作为最早的参考领域。

目前的 MVP 已有可运行的 Electron 工作台：左侧是项目与会话，中间是 Agent 聊天，右侧是文件工作区。普通文件显示源码；GDS/OAS 版图、Yosys JSON 网表和 VCD/FST/GHW 波形按格式启用专用 Viewer。输入工程任务后，Capability Broker 在项目所属领域内识别适用能力与阶段，并渐进披露 Skill 和工具。Debug 模式展示 L0–L3 决策日志。工作台通过 Kimi Agent SDK 启动真实会话，并在聊天区展示思考、Todo、工具和审批事件。模型端点、名称与 API Key 可在左下角 Settings → Model API 中配置。

```bash
pnpm install
pnpm --filter @industrial-agent-harness/desktop setup:layout
pnpm --filter @industrial-agent-harness/desktop setup:kimi
pnpm dev
```

版图 Viewer 需要 KLayout Python；也可通过 `KLAYOUT_PYTHON` 指向已有环境。启动后选择工程目录，在设置中填写模型 API 信息，再发送任务。执行 `pnpm build && pnpm start` 可运行构建后的桌面应用。现阶段桌面链路在 macOS 实测，Linux 与 Windows 发行包仍在开发中。

无界面任务入口可先用 `pnpm cli run --project-dir ./examples/chip-sobel --domain chip --task 'Inspect netlist signals' --scope-only` 查看能力 Scope 与披露 Trace；Agent 执行参数及 JSON Lines 输出见 [CLI 文档](apps/cli/README.md)。

无需克隆仓库即可从 [GitHub Releases](https://github.com/Zhiman-BJ/industrial-agent-harness/releases) 下载无 UI Harness 预发布包；安装与校验步骤见 [CLI 文档](apps/cli/README.md#github-release-安装)。开发时也可运行 `node scripts/package-headless.cjs` 生成同样的目录。仓库提供当前能力烟测和预期失败的 RTL 验证目标场景；逐场 JSONL 与汇总结果用于定位 Harness 缺口。这个打包产物保留 Broker、Skill 和 MCP 接入，但目前尚无默认 Domain MCP 服务器或真实工业 Runtime。

左侧 Projects 可绑定多个本地目录；首次启动会显示从 EDA Harness demo 提取的精简 Sobel 芯片示例。右侧工作区和其中的文件树默认收起，按需打开；文件树随当前项目切换。点击普通文件预览源码，点击项目内的 GDS、Yosys JSON 或 VCD 等工程产物会自动打开对应 Viewer。Sobel 示例中附有同一设计的网表、波形和版图产物。

一个本地目录对应一个 Project。点击左侧 Projects 标题旁的「＋」可填写项目名称、选择目录和 Domain；点击已有项目可打开详情页，查看目录并修改该项目的 Domain。Domain 在创建时用带 emoji 的圆角按钮选择，在项目列表和新 Session 的输入框中只读显示。Sobel 示例默认属于 Chip；领域列表随已注册能力更新。

## 文档

从 [文档目录](doc/README.md) 开始阅读架构、Capability Broker、Viewer 层、领域扩展和开发阶段。仓库开发规则见 [AGENTS.md](AGENTS.md)。

Viewer 代码源自 [Silicon Lens demo](https://github.com/Zhiman-BJ/silicon-lens-harness)；聊天区的思考与 Todo 呈现参考了带轨迹回放的 [EDA Harness demo](https://github.com/Zhiman-BJ/eda-harness-demo)，产品使用实时 SDK 事件。
