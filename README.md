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

目前的 MVP 已有可运行的 Electron 工作台：左侧是项目与会话，中间是 Agent 聊天，右侧是文件工作区。受支持的领域产物与 CSV/TSV、JSON/JSONL、Markdown、TXT/LOG 按格式启用 Viewer，其他文件显示源码；完整清单见下方“已接入的 Viewer”。输入工程任务后，Capability Broker 在项目所属领域内识别适用能力与阶段，并渐进披露 Skill 和工具。Debug 模式展示 L0–L3 决策日志。聊天标题栏的 Logs 可查看当前项目的详细 Agent 日志、完整工具参数与返回、上下文占用和压缩事件，并在运行中刷新。工作台通过 Kimi Agent SDK 启动真实会话，并在聊天区展示思考、Todo、工具和审批事件。模型端点、名称与 API Key 可在左下角 Settings → Model API 中配置。

```bash
pnpm install
pnpm --filter @industrial-agent-harness/desktop setup:layout
pnpm --filter @industrial-agent-harness/desktop setup:kimi
pnpm dev
```

版图 Viewer 需要 KLayout Python；也可通过 `KLAYOUT_PYTHON` 指向已有环境。启动后选择工程目录，在设置中填写模型 API 信息，再发送任务。执行 `pnpm build && pnpm start` 可运行构建后的桌面应用。现阶段桌面链路在 macOS 实测，Linux 与 Windows 发行包仍在开发中。

无界面任务入口可先用 `pnpm cli run --project-dir ./examples/chip-sobel --domain chip --task 'Inspect netlist signals' --scope-only` 查看能力 Scope 与披露 Trace；Agent 执行参数及 JSON Lines 输出见 [CLI 文档](apps/cli/README.md)。

无需克隆仓库即可从 [GitHub Releases](https://github.com/Zhiman-BJ/industrial-agent-harness/releases) 下载无 UI Harness 预发布包；安装与校验步骤见 [CLI 文档](apps/cli/README.md#github-release-安装)。开发时也可运行 `node scripts/package-headless.cjs` 生成同样的目录。仓库提供当前能力烟测和预期失败的 RTL 验证目标场景；逐场 JSONL 与汇总结果用于定位 Harness 缺口。这个打包产物保留 Broker、Skill 和 MCP 接入，但目前尚无默认 Domain MCP 服务器或真实工业 Runtime。

完整芯片 MCP 另以 [Chip Pack Release](https://github.com/Zhiman-BJ/industrial-agent-harness/releases/tag/chip-v0.6.0-preview.1) 独立发布，包含 EDA Harness 25 工具服务、领域 Skill 和 Kimi 适配生成器；[安装说明](domain-packs/chip/README.md)列出 uv 与工具镜像的准备步骤。它可先用于芯片场景；当前无 UI Core 尚未把 Chip Pack 纳入 Broker Scope。

左侧 Projects 可绑定多个本地目录；首次启动会显示从 EDA Harness demo 提取的精简 Sobel 芯片示例。右侧工作区和其中的文件树默认收起，按需打开；文件树随当前项目切换。点击普通文件预览源码，点击项目内的 GDS、Yosys JSON 或 VCD 等工程产物会自动打开对应 Viewer。Sobel 示例中附有同一设计的网表、波形和版图产物。

一个本地目录对应一个 Project。点击左侧 Projects 标题旁的「＋」可填写项目名称、选择目录和 Domain；点击已有项目可打开详情页，查看目录并修改该项目的 Domain。Domain 在创建时用带 emoji 的圆角按钮选择，在项目列表和新 Session 的输入框中只读显示。Sobel 示例默认属于 Chip；领域列表随已注册能力更新。

## 已接入的 Viewer

当前已有 8 种领域与素材 Viewer，以及 5 种不依赖 Domain 的通用文件 Viewer。打开当前 Project 文件树中的受支持文件会自动选择对应 Viewer；其他文件继续显示源码。

| Viewer | 支持的输入 | 查看能力与依赖 |
| --- | --- | --- |
| [芯片版图](doc/viewer-eda-reference.md) | `.gds`、`.gdsii`、`.oas`、`.oasis` | KLayout 按视口渲染、图层选择；需要 KLayout Python，可通过 `KLAYOUT_PYTHON` 指定 |
| [网表](doc/viewer-eda-reference.md) | Yosys `write_json` 生成的 `.json` | netlistsvg 在独立 worker 中生成网表图；普通 JSON 不进入此 Viewer |
| [波形](doc/viewer-eda-reference.md) | `.vcd`、`.fst`、`.ghw` | 内置本地 Surfer WASM，查看信号与时间轴 |
| [Godot 运行预览](doc/godot-viewer.md) | 完整的单线程 Godot 4 Web Export：同名 `.html`、`.js`、`.wasm`、`.pck` | 场景运行、暂停、单步、相机选择、场景树与节点检查；导出须包含 Harness Viewer Bridge，准备导出需要 Godot 与匹配的 Web 模板 |
| [图片](doc/godot-assets-viewers.md) | `.png`、`.jpg`、`.jpeg`、`.webp` | 透明背景、像素/平滑采样、平移与尺寸查看；无需 Godot |
| [Sprite 图集](doc/godot-assets-viewers.md) | `.sprite.json` 与项目内配套图片；图片预览也可切换图集模式 | 网格切分、选帧和裁剪预览；无需 Godot |
| [动画](doc/godot-assets-viewers.md) | 受支持的 Godot `.tres` / `.tscn` 动画文本资源；图集动作也可在素材预览中播放 | SpriteFrames 与单个 Sprite2D 的离散 `frame` 轨道，动作选择、播放、暂停、逐帧与时间轴；受限解析，不启动 Godot 引擎 |
| [KiCad 板图与原理图](doc/kicad-viewer.md) | `.kicad_pcb`、`.kicad_sch`，包括项目内引用的原理图子页 | 内置本地 KiCanvas，支持图层、网络、封装、符号与属性查看；无需安装 KiCad 或联网，V1 为只读 2D 预览 |
| [CSV/TSV 表格](doc/document-viewers.md) | `.csv`、`.tsv` | 首行表头开关、全文筛选、分页、原文入口；保留文本值，不执行公式 |
| [JSON 结构](doc/document-viewers.md) | 普通 `.json`；Yosys 网表和 `.sprite.json` 保留专用 Viewer | 对象/数组折叠、类型与数量、分支分页、原文入口；解析错误明确显示 |
| [JSON Lines](doc/document-viewers.md) | `.jsonl`、`.ndjson` | 按源行号查看记录、分页、JSON 结构和原文入口；错误指出出错行 |
| [Markdown 文档](doc/document-viewers.md) | `.md`、`.markdown` | 标题、列表、引用、代码块、表格和任务列表；保留原文，不执行 HTML 或加载嵌入资源 |
| [文本与日志](doc/document-viewers.md) | `.txt`、`.log` | 行号、全文行筛选、换行开关和分页；无需领域软件 |

所有 Viewer 共用标题栏的缩小、放大、Fit（适配视图）和全屏按钮，Esc 退出全屏，并支持画布内滚轮或触控板捏合缩放。波形缩放时间轴；Godot 缩放已挂载的运行预览并保留运行状态；KiCad 默认适配电路内容，Whole page 查看完整图纸；通用文档 Fit 恢复 100% 阅读比例，Shift+滚轮用于滚动。查看操作不修改工程文件或验证结论。通用文档只读 UTF-8，单文件上限 4 MiB，Markdown 为 256 KiB，另有行数、节点与单元格限制；具体格式和平台验证范围见各 Viewer 文档。

新增或扩展 Viewer 时，必须在同一次变更中更新本节的支持格式、查看能力、依赖与限制，并遵守 [Viewer 接入规则](AGENTS.md#viewer-integration-contract)。

## Viewer 示例项目

无需配置模型即可查看这些示例。点击 Projects 旁的「＋」绑定相应文件夹，选择 Domain，再打开右侧工作区和文件树。

| 示例文件夹 | Domain | 打开文件 |
| --- | --- | --- |
| [LED 电路板](examples/pcb-led/README.md) | PCB | `led.kicad_pcb` 查看板图，`led.kicad_sch` 查看原理图；本地 KiCanvas 运行时无需安装 KiCad |
| [Godot Playground](examples/godot-viewer/README.md) | Godot | `build/playground.html` 运行场景；`robot.png`、`robot.sprite.json` 和 `playground.tscn` 查看图片、图集和动画 |
| [通用文件](examples/document-viewers/README.md) | 任意已有 Domain | CSV/TSV 表格、JSON/JSONL、Markdown、TXT/LOG；无需领域软件 |

Godot 场景先安装 Godot 4 及匹配的 Web 导出模板，在仓库根目录运行 `node examples/godot-viewer/export.cjs`。导出脚本使用当前 Viewer Bridge 并生成单线程 Web 运行时，较大的导出文件仅在本地生成。

macOS 已实测这两个示例的真实渲染，以及 Godot 暂停、单步、相机选择、节点检查、素材预览与 Viewer 全屏。示例用于查看和交互演示，不代表工业验证结果。

## 文档

从 [文档目录](doc/README.md) 开始阅读架构、Capability Broker、Viewer 层、领域扩展和开发阶段。仓库开发规则见 [AGENTS.md](AGENTS.md)。

Viewer 代码源自 [Silicon Lens demo](https://github.com/Zhiman-BJ/silicon-lens-harness)；聊天区的思考与 Todo 呈现参考了带轨迹回放的 [EDA Harness demo](https://github.com/Zhiman-BJ/eda-harness-demo)，产品使用实时 SDK 事件。
