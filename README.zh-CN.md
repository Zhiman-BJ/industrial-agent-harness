# Industrial Agent Harness

[English](README.md) · 简体中文

[![状态：开发者预览版](https://img.shields.io/badge/status-developer%20preview-orange)](#预览版范围)
[![许可证：MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js：24+](https://img.shields.io/badge/Node.js-24%2B-339933)](package.json)

**面向工程项目的 AI 工作台：按范围使用专业工具，保留可核验的结果。**

Industrial Agent Harness 通过桌面工作台和无界面 CLI，将本地工程、Kimi Code、专业软件与工程证据连接起来。各领域通过 Domain Pack 提供知识、工具和验证方法。

> [!IMPORTANT]
> **开发者预览版（Developer Preview）。** 当前处于 Workbench MVP 阶段，已接入持久化、受范围约束的工程运行时。API、Pack 接口和运行时行为仍在迭代。本页描述当前源码；已发布的预览归档以各自版本说明为准。

[快速开始](#快速开始) · [领域扩展](#领域扩展) · [已接入的 Viewer](#已接入的-viewer) · [文档](#文档) · [许可证](#许可证)

## 可以做什么

- **围绕真实工程协作。** 将本地目录绑定到领域，使用多个聊天、恢复会话，并查看执行日志。
- **按任务获取知识和工具。** Capability Broker 渐进披露相关 Skill 与工具定义，并在执行时校验授权范围。
- **使用项目指导。** 自动发现 `.skill/`、`.skills/` 与标准项目技能目录，通过 Kimi 原生机制加载项目 `AGENTS.md`。剩余限制见[兼容性审计](doc/kimi-native-compatibility-audit.md)。
- **保留工程证据。** 领域运行时记录输入、动作、产物、验证和检查点；输入变化使当前证据失效，中断记录在重启后仍可追踪。
- **在工作台内查看产物。** 查看波形、网表、版图、KiCad 设计、Godot 素材和通用工程文件。
- **接入自动化与扩展。** 使用 CLI 的 JSON Lines 事件、Node SDK 或 stdio JSON-RPC；独立构建 Domain Pack，保留完整 Skill 资源并检查安装完整性。

Kimi Code 负责 Agent 循环、对话历史和上下文压缩；Harness 负责工程上下文、工具范围和证据。Agent 回合结束或进程退出成功，均不能直接判定工程验收通过。

共享工程执行路径：

```mermaid
flowchart LR
    Project["工程与当前状态"] --> Broker["Capability Broker"]
    Broker --> Agent["Kimi Code"]
    Agent --> Runtime["受范围约束的 Domain Runtime"]
    Runtime --> Tools["Domain Pack 工具"]
    Tools --> Evidence["产物与独立验证"]
    Evidence --> State["新状态与检查点"]
```

## 快速开始

准备 **Node.js 24+** 和 **pnpm 11.1.3**。Kimi Code 2.1.1 随依赖安装，实际运行 Agent 需模型 API 配置；已安装的 Chip 工具使用 Harbor 托管 EDA 镜像，需要运行中的 Docker，无需宿主 Python 或手工 `uv sync`。受保护的 Agent 支持 **macOS Apple Silicon（arm64）** 与具备 bubblewrap 的 **Linux x86-64**；使用其他平台前请查看[预览版范围](#预览版范围)。

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

侧栏将绿色 Core 标记与 Micius Harness 放在项目区上方的独立行，并与项目区左对齐。项目导航将项目名与领域元数据分为两行。设置按外观、Agent 配置与应用选项分组，保留原有操作；Escape 或关闭按钮将焦点返回设置入口，点击外部则关闭弹层并保留目标控件的焦点。

在 **Settings → Model API** 配置模型，再添加本地工程并选择领域。打开右侧工作区即可浏览文件；查看文件不需要模型 API Key。

**API 格式**按模型服务选择，与 Kimi Agent 内核分开。官方 MiniMax Chat Completions 使用兼容 OpenAI 配置；思考开关和档位因模型、协议而异，当前实测与缺口见[模型 API 兼容说明](doc/model-api-compatibility.md)。

准备脚本检查随包 **Kimi Code 2.1.1**，桌面和 CLI 共用认证 Server API 接入，不需要单独安装 Python Kimi。历史、诊断与兼容性边界见[迁移记录](doc/kimi-code-migration.md)。版图查看另需 KLayout Python，可运行 `pnpm --filter @industrial-agent-harness/desktop setup:layout`，或设置 `KLAYOUT_PYTHON`。

### 3. 维护者在 macOS Apple Silicon 运行原生回归

以下历史全套源码入口包含兼容性测试，维护者需准备宿主 Verilator、C++ 工具链、uv 和 Python 3.13。普通已安装 Chip 使用预构建 EDA 镜像，无需这些宿主 Python 步骤；当前托管和安装态测试还需运行中的 Docker：

```sh
brew install verilator
(cd "$(node scripts/pack-source.cjs chip-pack)/eda-harness" && uv sync --frozen --no-dev --python 3.13)
HARNESS_REQUIRE_CORE_NATIVE=1 pnpm run test:industrial-core
```

测试运行真实 RTL 仿真，检查断言、波形、失败处理、安装态 Pack 完整性和重启恢复。模型响应来自本地受控提供方，不消耗模型 API 额度，也不用于衡量模型能力。真实任务的准备方式和证据边界见[工业运行时说明](doc/p0-industrial-runtime.md)。

当前托管 Chip profile 已在 macOS ARM64 和 Linux x86-64 搭配 Docker 验收。历史 Linux [一键安装](releases/chip-linux-installer-v0.1.0-preview.3.md)保留各自版本的运行时与安装说明。

需要下载包时，请查看 [GitHub Releases](https://github.com/Zhiman-BJ/industrial-agent-harness/releases)，并按对应版本说明安装。[无界面安装](apps/cli/README.md#github-release-安装)和[领域 CLI 分包](doc/domain-cli-downloads.md)提供校验与外部依赖说明。历史归档不会自动获得当前源码的新功能。

当前源码消费 **Domain Packs 0.7.0**，owner 固定为 `1eae41d583bc526c36ae8a8f6c08343504949928`。安装 Pack 只安装可信能力、Skills 与适配器；原生依赖由用户在外部安装，容器准备和远程配置分开操作。在能力中心或项目详情中选择已验证的本机、容器或远程 Profile，可关联兼容的现有软件，或在用户已安装并启动 Docker 后显式准备容器镜像。原生 Profile 不提供 Harness 下载／安装入口。本机 FreeCAD、Godot 与隔离 DXF Runtime 不要求 Docker；Chip、PCB 设计与 DXF 容器路径仍需 Docker。产品提供 Chip、PCB、Godot、CAD 四个领域；新目录和历史已装条目均撤下 CUDA，独立实现保留。领域卡片有清晰边框、一行用途与折叠依赖说明；绿色就绪、黄色缺失、红色检查失败、中性色未检查，并明确依赖名称。最近检查失败覆盖旧 Ready 显示。Go 平台组件执行固定环境检测，本轮未将所有领域 MCP 重写为 Go。详见[分发 v2](doc/runtime-distribution-v2.md)、[安装体验](doc/install-experience.md)和[本轮验收证据](doc/qa-runtime-distribution-v2-20261012.md)。模型配置、环境就绪与工程验收是不同状态。本次源码改动不代表新的签名公众安装包、Core OTA、新增 Mac CI runner 或更广的平台资格。

**历史本地候选包：** 1.0.1-beta.1 Apple Silicon 桌面候选包列出全部五个领域：Chip、PCB、Godot、CAD 四个 Pack 可直接选择，未配置在线目录也能安装；CUDA 保持可见，明确显示远程服务前提和当前暂无可安装桌面包的状态。选择 PCB、Godot 或 CAD 后，应用自动在用户 Pack 目录准备固定官方 KiCad 10.0.6、Godot 4.7.2 或 FreeCAD 1.1.4；这三项托管工具无需用户运行命令或配置环境变量。Chip 仍需外部 Python、编译器及 EDA/PDK 环境。Core 内置 Kimi Code 2.1.1，模型 API 配置仍需单独完成。安装界面展示大小预估、进度、取消与恢复，完成后分别显示各领域的实际就绪状态。详见[安装体验与发行边界](doc/install-experience.md)及[CAD 安装验收](doc/macos-cad-distribution.md)。本地候选包尚不代表正式签名公众发行或真实 Core OTA 已通过验收。

## 领域扩展

| 领域                                                                              | 当前 0.7.0 能力                                                                                                            | 依赖与已验收范围                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Chip](https://github.com/Zhiman-BJ/industrial-domain-packs/tree/main/packs/chip) | 托管 EDA 操作、RTL 断言与 VCD、Yosys 综合检查，以及波形／网表／版图查看                                                    | macOS ARM64 与 Linux x86-64，需 Docker；Harbor 预构建镜像内含 Python 与工具。物理流程仍需工程自有 PDK／工艺输入；综合不等于等价性、LVS 或物理签核。                                 |
| [PCB](doc/pcb-godot-runtime.md)                                                   | 复用 PCBbench 设计工具和 Skill，支持用户工程的原理图／PCB 创建、修复、元件、检查与导出；普通项目无需 benchmark seed 或评分 | macOS ARM64；受限本机板图操作使用兼容 KiCad 10.0.6，完整设计路径使用固定 Docker gateway。实际 ERC／DRC 与适用分析分别记录，不承诺完整电气、合规或制造签核。                         |
| [CAD · FreeCAD / DXF](doc/freecad-domain-pack.md)                                 | FreeCAD 参数化创建／修改、FCStd/STEP/STL 导出及几何回读；受限 DXF 创建／检查／验证                                         | macOS ARM64；本机 FreeCAD 1.1.4、隔离本机 DXF Runtime 与固定 ezdxf Docker 运行时分别提供 Profile。AutoCAD 可选；DXF 仅涵盖声明的二维几何，不承诺通用 DWG/PDF 转换、强度或制造验收。 |
| [Godot](doc/pcb-godot-runtime.md)                                                 | 类型化场景变换／BoxMesh 修改，原生导入／回读／限帧验证；源码与 Web Export Viewer                                           | macOS ARM64；关联外部安装的兼容 Godot 4.7.2。验收限于显式结构属性，不含任意游戏 QA；Web Export 保留独立依赖。                                                                       |

共享环境层支持外部准备的 CLI 文件和隔离 Runtime 目录，以固定探针和完整树身份检测关联。Pack 安装不隐式准备任何依赖。真实安装态本机 DXF 已通过几何、错误核验、原生失败、取消／重开、完整树篡改拒绝与外部修复（43秒），无 Docker 调用。真实安装态 PCB 已通过 ERC、零错误 DRC、如实 UNKNOWN、取消／重开（25秒）；88 工具 fixture 分发回归单独计证。Chip 和完整 PCB design 本机执行仍未 qualified。历史 KiCad 下载／续传属于已撤下产品路径，不是当前验收阻塞。Pack 声明设计源与派生证据边界，共享执行后端负责持久工具会话、取消与清理。平台资格按上表分别成立，安装源码 Pack 本身不建立原生能力资格。

按 [Pack 作者教程](doc/pack-authoring.md)独立开发扩展。领域代码留在 Pack 内，共享 Core 与 Broker 不依赖具体领域。已注册、能够显示或原生烟测成功，均不代表完整工业工作流已经验收。[PCB／Godot 原生任务](doc/pcb-godot-runtime.md)及 owner 验收记录列出实际任务边界，不扩大其他工程支持承诺。先前[发布整改记录](doc/release-readiness-20261007.md)保留为历史证据。

### 任务成果

工具产生文件后，共享任务服务自动登记紧凑成果条目，辅助报告收在“附件与报告”中，文件和检查详情按需展开；CLI 输出同一分组和文件引用。主入口查看成果，原生文件／导出入口取走文件，检查摘要只对应记录版本。明确替代关系保留历史，并列方案全部可见。当前前台请求结束、只有一个支持的只读预览且未手动换文件／标签／聊天时，最多自动打开一次；历史、后台、失败和多方案不抢焦点。部分结果和文件变化明确提示，Agent 的 `select_result` 可选。FreeCAD 生成→连续修改→检查→卡片→OCCT 已在 macOS arm64 源码态验证，并另行记录真实模型演示；未扩大安装包或平台支持。[行为、契约和验收](doc/task-results.md)。

读取聊天历史不要求执行配置完成，远程项目也可直接新建／读取聊天。已有成果从记录库只读查询，不加载 Pack；单次读取复用文件校验，下次读取及打开文件重新检查内容。

Owner 已整理[全部五领域、六个 Pack 的声明草案与扩展计划](https://github.com/Zhiman-BJ/industrial-domain-packs/blob/cf72a46b6b4ba927b091ded71b2d52d227db0351/docs/result-presentation-plan.md)。当前接入任务成果的领域生产者为 FreeCAD；其他领域的成果接入仍属待实施项。当前产品目录已撤下 CUDA；历史独立实现保留。

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

远程 CAD 回执同样接入此 Viewer：有界产物索引按已校验的 SHA-256 关联 FCStd/STEP 配套文件，不改写下载字节。真实远程 build、桌面查看与自动释放沙箱的证据见[远程 CAD 验收](doc/evidence/remote-cad-20261019/README.md)。

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

[Harness CI 门禁](.github/workflows/ci.yml)在 Linux x64/arm64、macOS arm64、Windows x64 执行共享包与独立 CLI 包回归，在 macOS/Windows 验证桌面安装，声明 Apple Silicon 与 Linux x86-64 的工业 Core 验收 lane，Linux 还检查实际安装的 Chip CLI。容器化 Mac lane 当前需要具备本地 Docker 的适用 runner；本机验收不代表 GitHub 托管 lane 已通过。[CI 回归说明](doc/ci-regression.md)列出依赖、保留证据与明确的覆盖缺口；跳过不代表支持。安全问题按 [SECURITY.md](SECURITY.md) 的流程报告。

## 预览版范围

- **平台：** 桌面构建与首次启动 CI 目标为 macOS Apple Silicon（arm64）和 Windows x64。Intel Mac 暂不支持，不再发布 Intel 安装包或对应 Pack 目录目标；具备 Intel 测试机并完成安装及运行时验收后再恢复。签名安装器与真实升级仍需单独验收。
- **受保护执行：** macOS 使用 Seatbelt；Linux x86-64 使用 bubblewrap/seccomp，需允许非特权用户命名空间。Windows 受保护 Agent 执行仍不可用。
- **工具兼容性：** 旧领域 MCP 写入仍受隔离限制；所有领域都有受控文件编辑、声明任务执行和经 Runtime 审计的外部 MCP。独立 Computer Use 插件仍不可用。
- **工程验收：** 各领域 profile 验证声明的原生检查，保留失败或缺失证据；不据此推定 RTL 覆盖充分性、物理签核或完整工业工作流。
- **打包与评测：** 已记录本地未签名桌面检查和受控模型验证；签名发行、跨平台完整资格验证和正式付费模型比较仍需分别完成。

具体测试版本与结果见[验证记录](doc/harness-quality-three-tracks.md)。

## 许可证

项目自有贡献采用 **[MIT License](LICENSE)**，包括已获授权的 EDA Harness 与 EDA Harness demo 代码。

内置渲染器、字体、依赖和单独安装的专业工具保留各自许可证，完整发行物并非全部采用 MIT。请查阅 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和相关来源记录。本仓许可证不授予外部私有 PCB 资源的公众复用权。

所有领域共用的初始化、编辑、本地/Docker 任务和外部 MCP 见[共享工程底座](doc/shared-workspace.md)。打包消费者 CI 验证空工程创建、失败和修复；专业工具、模型及签核由 Pack/工程负责。

工程审批展示文件差异、声明命令和外部参数。`doctor` 无需模型即可检查执行前提；工作区筛选与显式本地依赖目录见[共享工程底座](doc/shared-workspace.md)。外部 MCP 在当前聊天进程内保留连接状态，状态丢失时明确失败。

### 内置远程运行（内部体验）

远程执行重构为会话式 Gateway v1.1：Kimi/Agent 留在本地，远端提供领域 MCP、专业软件和执行沙箱。Desktop/CLI 共用持久聊天绑定、显式不可变文件上传、规范工程证据导入与核验后的产物下载，下载不覆盖既有文件。本地输入变化须再次审核上传；停止本地等待不表示远端计算已取消。服务连接可用与软件/worker 已获资格分别显示。显式重绑创建新远端项目并保留旧绑定历史，不迁移旧 0.2 job 或工程事实。公网与登录配置仍留空；此次重构不构成 KiCad 或生产 Linux worker 资格，历史 H200 RTL 记录仅属于旧协议。见[远程执行与 CLI 命令](doc/remote-execution.md)。

桌面聊天将远程与任务状态合并为可折叠执行卡。聊天栏至少 960 px 宽时为展开卡预留侧边空间，更窄时在消息上方占位并限制滚动高度。任务进度、未完成工作与远程失败分别呈现；项目/设置页隐藏卡片但保留后台轮询。远程未就绪阻塞输入时，输入区显示原因并提供项目执行设置入口；Kimi 运行时缺失仍保留更高优先级提示。展示调整不改变上传确认、任务审批或既有就绪门禁。

2026-10-16 已通过本地 Computer Use 验收侧栏与设置交互、上传审核、就绪门禁、HTTP 503 故障恢复、结束会话、源文件预览及窄分屏控件。远程检查使用回环地址上的受控 UI fixture，明确记录 `engineeringExecution: false`；未运行真实模型、EDA 工具或自动原生 UI selftest 套件。已验范围与测试限制见 [PD-081](doc/product-decisions.md#pd-081聊天执行状态卡的层级与窄栏适配)。

从仓库根目录启动受控 fixture：

```sh
MOCK_REMOTE_TOKEN=mock-token node scripts/remote-ui-fixture.cjs
```

启动测试客户端时设置 `INDUSTRIAL_REMOTE_SERVICE_URL=http://127.0.0.1:8787`、`INDUSTRIAL_REMOTE_CREDENTIAL_ENV=MOCK_REMOTE_TOKEN` 和相同的 `MOCK_REMOTE_TOKEN`。文件上传仍需明确审核与确认。该 fixture 只验证 UI 协议行为，不构成生产远程执行或工程验收。

CLI 和 Desktop 现共用 Harness 任务服务；领域声明、Skill 和实现来自一个固定版本的 Domain Packs。见[消费迁移与验收](doc/shared-task-and-pack-consumption.md)。

此前托管版本以不可变提交固定 Domain Packs 0.6.0，由通用 Pack Manager 准备声明中的 Harbor 产物。以下为该版本历史证据。macOS ARM64 验收涵盖声明的 CAD、PCB、Godot profile 与 CUDA 远程客户端；托管 Chip 另已通过 Linux x86-64 安装和原生检查。具体证据与边界见[安装体验](doc/install-experience.md)及各领域验收记录。历史预览归档保留其原有依赖与范围。
