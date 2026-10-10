# Industrial Agent Harness

[English](README.md) · 简体中文

[![状态：开发者预览版](https://img.shields.io/badge/status-developer%20preview-orange)](#预览版范围)
[![许可证：MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js：24+](https://img.shields.io/badge/Node.js-24%2B-339933)](package.json)

**面向工程项目的 AI 工作台：按范围使用专业工具，保留可核验的结果。**

Industrial Agent Harness 通过桌面工作台和无界面 CLI，将本地工程、Kimi Code、专业软件与工程证据连接起来。各领域通过 Domain Pack 提供知识、工具和验证方法。

> [!IMPORTANT]
> **开发者预览版（Developer Preview）。** 当前处于 Workbench MVP 阶段，已跑通首条持久化 RTL 验证路径。API、Pack 接口和运行时行为仍在迭代。本页描述当前源码；已发布的预览归档以各自版本说明为准。

[快速开始](#快速开始) · [领域扩展](#领域扩展) · [已接入的 Viewer](#已接入的-viewer) · [文档](#文档) · [许可证](#许可证)

## 可以做什么

- **围绕真实工程协作。** 将本地目录绑定到领域，使用多个聊天、恢复会话，并查看执行日志。
- **配置 Agent。** 使用内置、Pack 提供或自定义角色，管理职责指令、工具、注册 Skills 与子角色，设置项目默认并在本机聊天开始前选择；已有聊天保留角色快照。见 [Agent 配置与边界](doc/agent-profiles.md)。
- **按任务获取知识和工具。** Capability Broker 渐进披露相关 Skill 与工具定义，并在执行时校验授权范围。
- **使用项目指导。** 自动发现 `.skill/`、`.skills/` 与标准项目技能目录，通过 Kimi 原生机制加载项目 `AGENTS.md`。剩余限制见[兼容性审计](doc/kimi-native-compatibility-audit.md)。
- **保留工程证据。** RTL 运行时记录输入、动作、产物、验证和检查点；输入变化使当前证据失效，中断记录在重启后仍可追踪。
- **在工作台内查看产物。** 查看波形、网表、版图、KiCad 设计、Godot 素材和通用工程文件。
- **接入自动化与扩展。** 使用 CLI 的 JSON Lines 事件、Node SDK 或 stdio JSON-RPC；独立构建 Domain Pack，保留完整 Skill 资源并检查安装完整性。

Kimi Code 负责 Agent 循环、对话历史和上下文压缩；Harness 负责工程上下文、工具范围和证据。Agent 回合结束或进程退出成功，均不能直接判定工程验收通过。

首条已实现的工业路径：

```mermaid
flowchart LR
    Project["工程与当前状态"] --> Broker["Capability Broker"]
    Broker --> Agent["Kimi Code"]
    Agent --> Runtime["受范围约束的 Domain Runtime"]
    Runtime --> Tools["Chip Pack 工具"]
    Tools --> Evidence["产物与独立验证"]
    Evidence --> State["新状态与检查点"]
```

## 快速开始

准备 **Node.js 24+** 和 **pnpm 11.1.3**。Kimi Code 2.1.1 随依赖安装，实际运行 Agent 需模型 API 配置；Chip MCP 另需 **uv** 和 **Python 3.13**。受保护的 Agent 支持 **macOS Apple Silicon（arm64）** 与具备 bubblewrap 的 **Linux x86-64**；使用其他平台前请查看[预览版范围](#预览版范围)。

```sh
git clone https://github.com/Zhiman-BJ/industrial-agent-harness.git
cd industrial-agent-harness
npm install --global pnpm@11.1.3
pnpm install --frozen-lockfile
```

### 1. 无模型体验 CLI

```sh
pnpm cli run \
  --project-dir ./examples/chip-sobel \
  --domain chip \
  --task "Inspect netlist signals" \
  --scope-only
```

该命令输出已注册的能力范围和披露过程，无需 API Key 或原生工程工具，不执行工程动作，也不验证设计。

### 2. 启动桌面工作台

```sh
pnpm --filter @industrial-agent-harness/desktop setup:kimi
pnpm dev
```

**布局按钮**可切换经典两列与聊天／文件／Viewer 共用的顶部标签栏。`+` 浏览项目文件；单击复用预览标签，双击或图钉固定保留。切换保留草稿和 Viewer 状态。窗口按屏幕可用区域启动，缩窄时自动采用标签页。见[自适应窗口与标签页](doc/desktop-layouts.md)。

**设置 → 语言** 可选择简体中文、English 或跟随系统，即时生效并记住选择。切换保留草稿、运行中的任务和查看器状态。Harness 自有控件与弹窗提供中英文；项目文件、聊天原文、工具返回和嵌入的第三方界面保留原内容。见[桌面语言切换](doc/desktop-languages.md)。

在 **Settings → Model API** 配置模型，再添加本地工程并选择领域。打开右侧工作区即可浏览文件；查看文件不需要模型 API Key。

**API 格式**按模型服务选择，与 Kimi Agent 内核分开。官方 MiniMax Chat Completions 使用兼容 OpenAI 配置；思考开关和档位因模型、协议而异，当前实测与缺口见[模型 API 兼容说明](doc/model-api-compatibility.md)。

准备脚本检查随包 **Kimi Code 2.1.1**，桌面和 CLI 共用认证 Server API 接入，不需要单独安装 Python Kimi。历史、诊断与兼容性边界见[迁移记录](doc/kimi-code-migration.md)。版图查看另需 KLayout Python，可运行 `pnpm --filter @industrial-agent-harness/desktop setup:layout`，或设置 `KLAYOUT_PYTHON`。

### 3. 在 macOS Apple Silicon 验证真实 RTL 闭环

完成上述 Kimi 准备后，安装 Verilator，并准备 C++ 工具链与 Chip Python 环境：

```sh
brew install verilator
(cd "$(node scripts/pack-source.cjs chip-pack)/eda-harness" && uv sync --frozen --no-dev --python 3.13)
HARNESS_REQUIRE_CORE_NATIVE=1 pnpm run test:industrial-core
```

测试运行真实 RTL 仿真，检查断言、波形、失败处理、安装态 Pack 完整性和重启恢复。模型响应来自本地受控提供方，不消耗模型 API 额度，也不用于衡量模型能力。真实任务的准备方式和证据边界见[工业运行时说明](doc/p0-industrial-runtime.md)。

Linux x86-64 芯片用户可使用[一键安装](releases/chip-linux-installer-v0.1.0-preview.3.md)，自动准备私有运行时、受保护 Agent 和 EDA 镜像。

需要下载包时，请查看 [GitHub Releases](https://github.com/Zhiman-BJ/industrial-agent-harness/releases)，并按对应版本说明安装。[无界面安装](apps/cli/README.md#github-release-安装)和[领域 CLI 分包](doc/domain-cli-downloads.md)提供校验与外部依赖说明。历史归档不会自动获得当前源码的新功能。

1.0.1-beta.1 本地 Apple Silicon 桌面候选包列出全部五个领域：Chip、PCB、Godot、CAD 四个 Pack 可直接选择，未配置在线目录也能安装；CUDA 保持可见，明确显示远程服务前提和当前暂无可安装桌面包的状态。选择 PCB、Godot 或 CAD 后，应用自动在用户 Pack 目录准备固定官方 KiCad 10.0.6、Godot 4.7.2 或 FreeCAD 1.1.4；这三项托管工具无需用户运行命令或配置环境变量。Chip 仍需外部 Python、编译器及 EDA/PDK 环境。Core 内置 Kimi Code 2.1.1，模型 API 配置仍需单独完成。安装界面展示大小预估、进度、取消与恢复，完成后分别显示各领域的实际就绪状态。详见[安装体验与发行边界](doc/install-experience.md)及[CAD 安装验收](doc/macos-cad-distribution.md)。本地候选包尚不代表正式签名公众发行或真实 Core OTA 已通过验收。

## 领域扩展

| 领域                                                                                                                            | 预览版已提供                                                                                         | 依赖与限制                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Chip](https://github.com/Zhiman-BJ/industrial-domain-packs/tree/b9759342cace66df0be0c4559b7c24fb28ea07d9/packs/chip/README.md) | EDA 知识与工具注册、持久化的声明式 RTL 验证路径，以及波形、网表、版图查看                            | Core 路径需要 Python 与 Verilator；其他 EDA 流程另需工具、镜像或 PDK，完整执行仍需接入 Runtime。       |
| [CUDA](doc/cuda-domain-pack.md)                                                                                                 | Compiler / Evaluator 两个远程 MCP、算子优化 Skill 与 canonical 原生证据                              | 开发者配置两个已认证端点；固定 RTX 4090 AXPBY；私有执行依赖外置，尚不提供桌面安装包。                   |
| [PCB](doc/pcb-godot-runtime.md)                                                                                                 | 公开类型化矩形板框／已有安装孔修改，原生 DRC 与独立任务验证；KiCad Viewer                            | macOS Apple Silicon，打包桌面版自动准备官方 KiCad 10.0.6 及其 Python；有限机械布局任务，无电气／制造验收，不依赖私有 actor。 |
| [Godot](doc/pcb-godot-runtime.md)                                                                                               | 类型化场景变换／BoxMesh 修改，原生导入／回读／限帧验证；源码与 Web Export Viewer                     | macOS Apple Silicon，打包桌面版自动准备 Godot 4.7.2；验证显式结构约束，无完整游戏 QA。Web Export 保留独立依赖。  |
| [CAD · FreeCAD](doc/freecad-domain-pack.md)                                                                                     | 参数化草图、拉伸、打孔、布尔建模和版本化参数/轮廓修改；FCStd/STEP/STL 导出、独立回读验证与 OCCT 查看 | 打包桌面版自动准备 FreeCAD 1.1.4 macOS arm64；只支持受限原生特征，不验收机械强度或可制造性。           |

按 [Pack 作者教程](doc/pack-authoring.md)独立开发扩展。领域代码留在 Pack 内，共享 Core 与 Broker 不依赖具体领域。已注册、能够显示或原生烟测成功，均不代表完整工业工作流已经验收。[PCB／Godot 原生任务](doc/pcb-godot-runtime.md) 已为显式首批任务补齐共享 Runtime；不扩大其他工程支持承诺。先前[发布整改记录](doc/release-readiness-20261007.md)保留为历史证据。


### 任务成果

工具产生文件后，共享任务服务自动登记紧凑成果条目，辅助报告收在“附件与报告”中，文件和检查详情按需展开；CLI 输出同一分组和文件引用。主入口查看成果，原生文件／导出入口取走文件，检查摘要只对应记录版本。明确替代关系保留历史，并列方案全部可见。当前前台请求结束、只有一个支持的只读预览且未手动换文件／标签／聊天时，最多自动打开一次；历史、后台、失败和多方案不抢焦点。部分结果和文件变化明确提示，Agent 的 `select_result` 可选。FreeCAD 生成→连续修改→检查→卡片→OCCT 已在 macOS arm64 源码态验证，并另行记录真实模型演示；未扩大安装包或平台支持。[行为、契约和验收](doc/task-results.md)。

读取聊天历史不要求执行配置完成，远程项目也可直接新建／读取聊天。已有成果从记录库只读查询，不加载 Pack；单次读取复用文件校验，下次读取及打开文件重新检查内容。

Owner 已整理[全部五领域、六个 Pack 的声明草案与扩展计划](https://github.com/Zhiman-BJ/industrial-domain-packs/blob/cf72a46b6b4ba927b091ded71b2d52d227db0351/docs/result-presentation-plan.md)。当前接入任务成果的领域生产者为 FreeCAD；其他领域的成果接入仍属待实施项。当前消费版本保留 main 已接入的 CUDA 支持。

## 已接入的 Viewer

Harness 自有 Viewer 控件跟随 **设置 → 语言**（简体中文 / English），切换保留缩放、选择等显示状态；上游嵌入界面保留自身语言。语言声明与 Desktop/Viewer 译文统一维护在一个[配置文件](apps/desktop/i18n.config.json)，详见[语言范围与维护方式](doc/desktop-languages.md)。

从当前工程的文件树打开产物，自动选择对应 Viewer。查看器共用缩放、Fit 与全屏操作，查看不改变源码或验证结果。

| Viewer                                      | 输入                                                                           | 查看能力与限制                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [芯片版图](doc/viewer-eda-reference.md)     | GDS/GDSII、OAS/OASIS                                                           | 按视口渲染和图层选择，需要 KLayout Python。                                                                                                                                                                                                                                                                                                                                             |
| [网表](doc/viewer-eda-reference.md)         | Yosys `write_json` 输出                                                        | 独立 worker 中生成 netlistsvg 图，普通 JSON 使用文档查看器。                                                                                                                                                                                                                                                                                                                            |
| [波形](doc/viewer-eda-reference.md)         | VCD、FST、GHW                                                                  | 内置 Surfer WASM，查看信号与时间轴。                                                                                                                                                                                                                                                                                                                                                    |
| [KiCad](doc/kicad-viewer.md)                | `.kicad_pcb`、`.kicad_sch` 与工程子页                                          | 本地 KiCanvas 展示图层、网络和符号，只读 2D 查看，无需安装 KiCad。                                                                                                                                                                                                                                                                                                                      |
| [Godot Web Export](doc/godot-viewer.md)     | 配套 HTML/JS/WASM/PCK                                                          | 运行、暂停、单步与节点检查，需要含 Viewer Bridge 的单线程导出。                                                                                                                                                                                                                                                                                                                         |
| [图片与图集](doc/godot-assets-viewers.md)   | PNG/JPEG/WebP、`.sprite.json` 与配套图片                                       | 平移、采样模式、图集选帧与裁剪预览，无需 Godot 运行时。                                                                                                                                                                                                                                                                                                                                 |
| [动画](doc/godot-assets-viewers.md)         | 受支持的 `.tres`/`.tscn` 与图集动画                                            | 有限 SpriteFrames/Sprite2D 格式的播放与逐帧，不运行 Godot 引擎。                                                                                                                                                                                                                                                                                                                        |
| [工程文件](doc/engineering-file-viewers.md) | Godot 场景/资源/脚本、KiCad 库/规则、Gerber/钻孔、STEP/VRML 和部分 3D/音频格式 | 结构、制造层与媒体预览，几何和语义范围有限，不提供编辑或制造验收。                                                                                                                                                                                                                                                                                                                      |
| [CAD · OCCT](doc/freecad-domain-pack.md)    | STL；Pack 生成的 FCStd/STEP 与经哈希检查的配套 BREP/STL、可选原生草图数据      | 官方 OCCT 7.9.2 AIS/V3d WebGL2：曲面、轮廓、X/Y/Z 封口剖切、明确的“测量”按钮，分开单对象尺寸与两对象最短距离，点击面/边直接在模型上标注 BREP 边长/直径/面积/最短距离，不弹出测量侧栏；草图几何、尺寸和约束高亮。共享导航与全屏，窗口缩放保持模型比例；工作区分隔线可拖动或键盘调整、双击复位；本地 WASM，需 WebGL2。只读，测量名义几何，不含公差或工程验收。macOS arm64 Electron 实测。 |
| [通用文档](doc/document-viewers.md)         | CSV/TSV、JSON、JSONL/NDJSON、Markdown、TXT/LOG                                 | 表格、结构、记录与文本搜索；只读受限 UTF-8 输入，不执行公式或嵌入 HTML。                                                                                                                                                                                                                                                                                                                |

完整格式清单、文件上限与渲染依赖见各 Viewer 文档。新增接入需同时更新中英文 README，并遵守 [Viewer 接入契约](AGENTS.md#viewer-integration-contract)。

可先体验 [Sobel 芯片工程](examples/chip-sobel/README.md)、[LED 电路板](examples/pcb-led/README.md)、[Godot Playground](examples/godot-viewer/README.md)或[通用文档示例](examples/document-viewers/README.md)。这些用于查看演示，Godot Web Export 需单独生成，示例不作为工程验收证据。

## 文档

| 阅读入口                                                                       | 内容                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [文档索引](doc/README.md)                                                      | 架构、产品决策与模块说明，详细文档目前以中文为主。                             |
| [CLI](apps/cli/README.md) · [Node SDK](doc/sdk.md)                             | 任务、流事件、聊天恢复、取消与 stdio JSON-RPC。                                |
| [Pack 开发](doc/pack-authoring.md) · [版本化契约](doc/contracts-versioning.md) | 独立开发、资源、兼容性与规范工业事实。                                         |
| [当前交付与验证](doc/harness-quality-three-tracks.md)                          | 已实现范围、验证记录与剩余工作；历史架构提案不代表实现承诺。                   |
| [配对评测基线](doc/benchmark-baseline.md)                                      | 原生 Kimi/Harness 对比、冻结输入与独立验收，正式模型成功率和成本结果尚待运行。 |
| [安全说明](SECURITY.md) · [第三方清单](THIRD_PARTY_NOTICES.md)                 | 执行边界、问题报告与组件来源。                                                 |

## 开发与贡献

欢迎提交 Issue 和 Pull Request。请提供源码提交、操作系统、受影响领域、最小复现和脱敏日志。修改代码前阅读 [AGENTS.md](AGENTS.md)，将领域行为留在 Pack 内，并验证相关真实执行路径。

```sh
pnpm run test
pnpm run test:architecture
pnpm run test:release
pnpm run format:check
```

[Harness CI 门禁](.github/workflows/ci.yml)在 Linux x64/arm64、macOS arm64、Windows x64 执行共享包与独立 CLI 包回归，在 macOS/Windows 验证桌面安装，在 Apple Silicon 与 Linux x86-64 验证工业 Core 闭环，Linux 还检查实际安装的 Chip CLI。[CI 回归说明](doc/ci-regression.md)列出依赖、保留证据与明确的覆盖缺口；跳过不代表支持。安全问题按 [SECURITY.md](SECURITY.md) 的流程报告。

## 预览版范围

- **平台：** 桌面构建与首次启动 CI 目标为 macOS Apple Silicon（arm64）和 Windows x64。Intel Mac 暂不支持，不再发布 Intel 安装包或对应 Pack 目录目标；具备 Intel 测试机并完成安装及运行时验收后再恢复。签名安装器与真实升级仍需单独验收。
- **受保护执行：** macOS 使用 Seatbelt；Linux x86-64 使用 bubblewrap/seccomp，需允许非特权用户命名空间。Windows 受保护 Agent 执行仍不可用。
- **工具兼容性：** 旧领域 MCP 写入仍受隔离限制；所有领域都有受控文件编辑、声明任务执行和经 Runtime 审计的外部 MCP。独立 Computer Use 插件仍不可用。
- **工程验收：** 首条 Core 路径验证声明的 RTL/testbench 断言与证据；覆盖率充分性、物理签核和其他领域的完整闭环尚待实现与验收。
- **打包与评测：** 已记录本地未签名桌面检查和受控模型验证；签名发行、跨平台完整资格验证和正式付费模型比较仍需分别完成。

具体测试版本与结果见[验证记录](doc/harness-quality-three-tracks.md)。

## 许可证

项目自有贡献采用 **[MIT License](LICENSE)**，包括已获授权的 EDA Harness 与 EDA Harness demo 代码。

内置渲染器、字体、依赖和单独安装的专业工具保留各自许可证，完整发行物并非全部采用 MIT。请查阅 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和相关来源记录。本仓许可证不授予外部私有 PCB 资源的公众复用权。

所有领域共用的初始化、编辑、本地/Docker 任务和外部 MCP 见[共享工程底座](doc/shared-workspace.md)。打包消费者 CI 验证空工程创建、失败和修复；专业工具、模型及签核由 Pack/工程负责。

工程审批展示文件差异、声明命令和外部参数。`doctor` 无需模型即可检查执行前提；工作区筛选与显式本地依赖目录见[共享工程底座](doc/shared-workspace.md)。外部 MCP 在当前聊天进程内保留连接状态，状态丢失时明确失败。

### 内置远程运行（内部体验）

项目可选择本机或知满远程，首次上传展示目的地和文件清单，聊天内显示任务状态。Desktop/CLI 共用 Remote Runtime，已准入领域工具在现有有限 CPU 沙箱池执行。公网地址与登录默认配置留空；已验证 macOS Apple Silicon 客户端连接 H200 Linux 进行真实 RTL 检查，公网接入及其他远程领域仍待验收。见[内置远程运行](doc/remote-execution.md)。

CLI 和 Desktop 现共用 Harness 任务服务；领域声明、Skill 和实现来自一个固定版本的 Domain Packs。见[消费迁移与验收](doc/shared-task-and-pack-consumption.md)。

PCB 与 Godot 专业 Runtime Actions 提供有限的 macOS Apple Silicon 原生任务，领域实现统一维护在精确固定的 Domain Packs 包中。当前 1.0.1-beta.1 源码消费端固定 Domain Packs 0.5.2 提交 `b9759342cace66df0be0c4559b7c24fb28ea07d9`，由通用 Pack Manager 准备声明中的官方原生软件。见[任务边界、依赖与验收](doc/pcb-godot-runtime.md)；其他平台与远端仍未验收。
