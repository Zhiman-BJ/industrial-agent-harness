# 文档目录

开发前必读：[已接受的跨仓架构契约 IH-ARCH-001](architecture-contract.md)。领域源码归属、CLI/Desktop 入口、执行后端和冻结迁移例外由该契约及必跑 CI 约束。

当前实现：[共享任务服务与 Pack 消费迁移](shared-task-and-pack-consumption.md)。

项目首页：[English](../README.md) · [简体中文](../README.zh-CN.md)。当前版本为**开发者预览版（Developer Preview）**，许可证见 [MIT License](../LICENSE) 与[第三方清单](../THIRD_PARTY_NOTICES.md)。

这里记录 Industrial Agent Harness 的产品架构与开发计划。1.0.1-beta.1 本地 Apple Silicon 候选包展示全部五域，提供 Chip、PCB、Godot、CAD 四域安装选择，按固定 owner 声明自动准备后三者的官方原生软件；Chip 外部工具链仍需配置，CUDA 明示远程服务前提和当前版本不可安装的状态。

桌面 MVP、三种内置 EDA Viewer、Godot Web Export Viewer V1、素材 Viewer、KiCad Viewer V1、五种通用文件 Viewer、确定性 Broker 和 Kimi Code 接口已落地；Godot、KiCad 与通用文件示例链路已通过 macOS Electron 实测。Chip 的 MCP 与 RTL Runtime、FreeCAD Runtime、PCB／Godot 的有限公开原生 Runtime 通过共享任务接口供 Desktop/CLI 消费。PCB／Godot 原有 MCP 为历史独立诊断路径；三平台完整工业支持仍未验收。文档中的其余接口与验收项，除明确标为“已落实”的事项外，均为设计提案。

2026-10-04 更新：[三轨整改记录](harness-quality-three-tracks.md)记录首条真实 RTL 持久化闭环、发行资源修复、SDK 和配对评测入口。受保护的 Agent 当前在 macOS Apple Silicon（arm64）验证；桌面构建与首次启动 CI 保留 Apple Silicon 与 Windows x64，Intel Mac 暂不支持，范围决定见 [PD-036](product-decisions.md#pd-036暂停-intel-mac-支持)。其他领域及平台仍需接入和验收。2026-09-23 评审文件保留为历史基线。

Godot/PCB 的源工程文件另有[受限只读预览](engineering-file-viewers.md)，覆盖场景、脚本、库、制造文件和部分 3D 素材；其保真范围与 macOS 验证见该文档。

当前里程碑是 **Industrial Core Vertical Slice**。2026-09-23 的架构评审材料已核对并纳入以下四页；它们是现状、约束、路线和验收的主入口，旧版开发计划保留为背景资料。

| 当前评审文档                                                                     | 用途                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------ |
| [现状与缺口](01-current-state-and-gaps.md)                                       | 已实现的 Workbench MVP、缺失的工业内核与替换方向 |
| [架构不变量](02-architecture-invariants.md)                                      | 硬约束、当前 Gate 和已有 Prototype 的限界        |
| [实施路线图](03-implementation-roadmap.md)                                       | P0–P3 顺序及首条真实 Vertical Slice 的交付条件   |
| [Definition of Done 与架构测试](04-definition-of-done-and-architecture-tests.md) | 模块完成标准、CI 门禁与尚未满足的 E2E Gate       |
| [Prototype Register](prototype-register.json)                                    | 机器可读的现有捷径、冻结范围和替换目标           |

| 文档 | 内容 |
| --- | --- |
| [Kimi Code 迁移](kimi-code-migration.md) | 固定 2.1.1、认证 Server API、身份映射与外壳兼容验收 |
| [Kimi 后台兼容](kimi-background-compatibility.md) | 原生后台 Bash、WaitFor、自动续答与 Headless 生命周期 |
| [系统架构](architecture.md) | Kimi Code、桌面端、Broker、工业运行时与领域包的职责和数据流 |
| [Capability Broker](capability-broker.md) | Capability 解析、skill 与 MCP 工具的渐进式披露、Scope 和 Trace |
| [任务成果](task-results.md) | 自动成果卡、确切版本关联、可选选择、CLI/Desktop 与原生验收 |
| [全领域成果声明与扩展计划（Owner）](https://github.com/Zhiman-BJ/industrial-domain-packs/blob/cf72a46b6b4ba927b091ded71b2d52d227db0351/docs/result-presentation-plan.md) | 五领域、六 Pack 的声明草案、生产缺口、跨仓顺序与待实施测试矩阵 |
| [Viewer 层](viewer-layer.md) | 内置查看、关键产物预览、外部打开与证据边界 |
| [通用文件 Viewer](document-viewers.md) | CSV/TSV、JSON、JSONL、Markdown、TXT/LOG 的只读查看、分页与文件边界 |
| [素材 Viewer](godot-assets-viewers.md) | 图片预览、图集切分、动画播放与 Godot 文本资源支持范围 |
| [KiCad Viewer V1](kicad-viewer.md) | PCB domain 的本地板图/原理图查看、文件边界与运行时来源 |
| [Godot/PCB 工程文件预览](engineering-file-viewers.md) | 场景、脚本、库、制造文件与 3D 素材的只读查看、格式边界和验证 |
| [Godot Viewer V1](godot-viewer.md) | Web Export 准备、Scene Tree 与 Viewer Bridge 的当前接入边界 |
| [共享 Chip Pack MCP](domain-mcp-integration.md) | Desktop/CLI 注册、Scope 网关、项目绑定、审批与实测 |
| [PCB／Godot 专业 Runtime](pcb-godot-runtime.md) | 公开首批任务、精确依赖、独立验证、安装路径与失败／恢复验收 |
| [领域安装体验](install-experience.md) | 1.0.1-beta.1 五域展示、四域安装、官方依赖准备、取消恢复、旧版数据保留验收及正式发行边界 |
| [共享 PCB Bench MCP](pcb-mcp-integration.md) | 固定外部 PCB 工具、完整 Skill、资源覆盖、协议验证与原生执行前提 |
| [Godot game MCP](godot-mcp-integration.md) | 任务范围披露、源场景检查、原生导入与限时运行的证据边界 |
| [Godot 与 PCB Viewer 文件优先级](game-pcb-viewer-priorities.md) | 现有支持及值得增加的工程文件查看能力 |
| [PCB-bench 本地六题诊断](pcb-bench-local-trial-2026-09-30.md) | 六个开发集任务的原生试跑、独立验收与 Harness 缺口 |
| [内置远程运行](remote-execution.md) | 项目运行位置、上传确认、任务状态、共享 Runtime 与空配置边界 |
| [外部 MCP](external-mcp.md) | UI/CLI 共用的 stdio/HTTP/SSE 注册、渐进披露、审批、截图与配置边界 |
| [Domain Pack](domain-pack.md) | 芯片与 PCB 等领域的扩展方式和最小契约 |
| [Pack 作者教程](pack-authoring.md) | 独立构建、安装和验证外部 Pack，资源与升级兼容 |
| [工业契约版本](contracts-versioning.md) | v1 工业事实、旧观察数据与 TypeScript 消费 |
| [共享工程底座](shared-workspace.md) | 全领域空工程初始化、受控编辑、声明任务和外部 MCP |
| [P0 工业闭环](p0-industrial-runtime.md) | 真实 RTL、隔离、持久化和失败恢复的范围 |
| [FreeCAD CAD Pack](freecad-domain-pack.md) | 参数化 3D 零件建模、持久 Runtime、独立几何回读、实体 Viewer 与 macOS arm64 原生 CI |
| [Kimi 原生机制兼容性审计](kimi-native-compatibility-audit.md) | 项目发现、输入命令、配置、会话、环境和执行边界的实际差异及修复 |
| [CI 回归与托管环境](ci-regression.md) | 四种原生 OS/架构环境、分层门禁、测试证据与覆盖缺口 |
| [QA 测试用例与自动执行手册](qa-runbook.md) | T0–T6 分层用例目录、命令与通过判据；Agent 自动执行整个 QA 流程的唯一入口 |
| [Node SDK](sdk.md) | 项目绑定、聊天恢复、流事件、取消和 stdio RPC |
| [配对评测基线](benchmark-baseline.md) | 原生 Kimi/Harness、冻结输入、独立验收与正式结果边界 |
| [早期开发计划](development-plan.md) | 两份原始 Plan 的阶段性整理；里程碑顺序以新的实施路线图为准 |
| [产品决策记录](product-decisions.md) | 已确认的用户交互与项目模型决定，包括 Project、目录、Domain 和 Session 的关系 |
| [双版本产品边界与公开清单](editions.md) | Internal/OSS edition 划分、机器清单校验、导出约定与发布门禁（#101/#100） |
| [桌面 UI 优化](desktop-ui-refinement.md) | Impeccable 产品模式、设计系统、首次使用与项目导航、主题与窗口验收 |
| [自适应窗口与标签页](desktop-layouts.md) | 两列／多标签切换、窄窗口、显示器边界、查看状态与回归 |
| [桌面语言切换](desktop-languages.md) | 中英文与跟随系统、偏好保存、自有控件范围、状态保留与验证 |
| [架构决策记录](decisions.md) | 已确定的决定、提案间的差异和需要验证的接口 |
| [27B / 256k 上下文适配计划](27b-256k-context-plan.md) | Kimi 接入的输出边界、会话复用、观测与后续评测门禁 |
| [27B 上下文评测结果](27b-evaluation-results.md) | 真实模型的合成检索、SDK 工具调用与压缩后续接证据 |
| [聊天持久化](chat-persistence.md) | Desktop/CLI 历史聊天、Kimi 原生上下文恢复、Scope 会话段、中断与验证边界 |
| [按领域下载 CLI](domain-cli-downloads.md) | Chip/PCB/Godot 独立包、默认领域绑定与测试依赖 |
| [Linux Chip 一键安装 preview.3](../releases/chip-linux-installer-v0.1.0-preview.3.md) | Docker helper 升级、宿主环境检查、受保护 Agent 与安装验证 |
| [2026-10-07 发布整改](release-readiness-20261007.md) | 全部审计问题修复、本地 DMG、原生 subagent/Viewer/Pack 验收与公众发行边界 |
| [Apple Silicon CAD 分发](macos-cad-distribution.md) | 首次选择、官方 FreeCAD 自动准备、修复、真实任务与发行边界 |
| [安装、补装与 OTA 规划](installation-and-ota-plan.md) | macOS/Windows 桌面安装、多选 Domain、后续补装与 Core/Pack 更新的 P3 提案 |
| [CLI 与 Bench 入口](../apps/cli/README.md) | 无界面单任务命令、JSON Lines 事件、模型与工件输入 |
| [模型 API 与思考参数](model-api-compatibility.md) | MiniMax 协议修复、OpenCode 研究与不同模型的参数接入边界 |
| [Computer Use 桥接包](../packages/computer-use-bridge/README.md) | GUI 横切插件：固定二进制安装、18 工具面、MCP 进程模型与已知缺口 |
| [Agent 聊天 UI 来源](agent-ui-provenance.md) | EDA Harness demo 的思考、Todo、工具呈现如何接入实时 SDK 事件 |
| [并行 Session](parallel-sessions.md) | 同项目与跨项目聊天并行、后台审批、停止与配置影响范围 |
| [多会话资源保护与压测](session-resource-guards.md) | 共用执行/常驻额度、空闲回收、原生恢复、内存准入与真实 Kimi 进程压测 |
| [全仓分析与优化](repository-optimization.md) | 2026-10-03 的模块分析、维护改动、性能基准、验证与后续优化优先级 |

来源：用户提供的《Industrial Harness 架构与开发 Plan》（2026-09-23，v0.1 提案）和《Industrial Capability Broker 开发 Plan》。本目录提炼两份材料供仓库实施使用，不把计划中的示例接口当成已经存在的实现。

2026-09-23 的四份架构评审文档由用户另行提供，已修正最小持久化顺序、失败 Action 的空产物处理，以及固定 MCP Gateway surface 与动态 Scope 的验收表述。`AGENTS.md` 只保留执行摘要；细节和现有例外以本目录为准。
