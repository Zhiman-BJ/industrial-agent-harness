# EDA Harness

让 Agent 通过统一 MCP 接口执行 EDA 工作流，并保存可追溯的输入、运行、产物和验证结果。新会话可以恢复同一个设计目标和状态，继续工作。

交付范围从 Shared MCP Gateway 开始，包括持久化上下文、Harness Core、执行运行时和 EDA 工具封装。Claude/Kimi 接入包是薄适配层；Ibex、Counter 等具体设计仅用于测试，不进入 MCP 发行包。

## 安装与第一次使用

已有 Claude Code、uv 和本私有仓库的 Git 访问权限时，在终端执行：

```bash
claude plugin marketplace add Zhiman-BJ/eda-harness && claude plugin install eda-harness@zhiman-eda
```

然后在设计目录启动 Claude，让它调用 `get_tool_guide()` 和 `get_operational_context()`。手册与能力查询不要求已有项目配置；实际执行需要有效的 `eda.yaml`、EDA 工具环境及相应工艺输入。

**安装插件不会安装 EDA 工具镜像或 PDK。** 项目初始化、镜像构建、只读接入和 Kimi 接入见 [安装与接入](docs/installation.md)。

插件 v0.6.0 绑定 Harness 0.6.0 的固定源码提交，包含工具级扩展、服务身份诊断、显式项目路径、Docker 默认初始化，Verilator timing 仿真的 C++20 编译修复，Agent 可查询的项目 Schema 与输入类别契约，以及以 Yosys show/viz 为默认后端的网表查看器。Python 与间接依赖的锁定方式见 [依赖锁定](docs/dependency-locking.md)。

## Agent 如何使用

首次使用先调用 `check_environment()`；执行目标前调用 `check_environment(target="lint")`，按返回建议补齐环境。源码 CLI 对应 `eda doctor --target lint`，详见 [环境就绪检查](docs/installation.md#环境就绪检查)。

1. **恢复任务**：`get_operational_context` 获取目标、当前状态、活动运行和阻塞信息。
2. **确认能力**：`list_actions` 获取项目 action ID；`tool_capabilities` 获取操作、后端及参数 Schema。
3. **修改并检查**：修改设计输入后调用 `workspace_status`，再调用 `preflight` 检查目标配置。
4. **执行**：`run_until` 提交依赖链，或在依赖有效时使用 `run_action`；通过 `get_run` 查询结果。
5. **核对证据**：读取诊断、指标和产物，并检查当前工作区的 `acceptance`。

执行 `SUCCESS` 只表示计算成功。验收 `PASS` 才表示配置的目标满足；`BLOCKED` 表示检查未通过，`INCOMPLETE` 表示证据不足。KEEP 实验记录不会改变验收结果。

## 可用能力

源码注册 **25 个 MCP 工具**；只读模式保留 **16 个**。它们用于任务状态、执行、证据和验收管理，完整签名由实现自动生成到 [MCP 接口参考](docs/mcp-tools.md)。

EDA 操作通过 `eda.yaml` 配置，再由 MCP 提交执行：

| 工作 | 操作 | 后端 |
|---|---|---|
| RTL 检查与综合 | lint、simulate、synthesize | Verilator、Yosys |
| 物理实现 | floorplan、place、cts、route、streamout | OpenROAD、KLayout |
| 分析 | sta、power | OpenROAD 内嵌 OpenSTA |
| 版图验证 | extract、lvs、drc | Magic、Netgen、KLayout |
| 波形处理 | waveform | GTKWave |

插件 v0.6.0 包含工具级扩展；能力与验证范围见 [工具级操作契约](docs/tool-operations.md)。

统一镜像包含 **7 种主工具**。28 类结构化操作的输入、输出和限制见 [EDA 操作与配置](docs/semantic-api.md)。MCP 工具数量、EDA 操作数量和底层软件数量是不同概念。

## 查看波形与版图

`viewer_capabilities` 检查 MCP 所在电脑上的原生查看器；从 `get_artifacts` 选择产物后，用 `open_viewer` 导出并打开波形、版图或报告。支持 GTKWave、KLayout、Magic、OpenROAD GUI，以及 Yosys show/viz 网表图（默认使用项目执行环境中的 Graphviz，netlistsvg 为可选项）。

桌面查看器与 Docker 内的计算工具分别安装。`open_viewer` 不在只读模式中提供，`LAUNCHED` 只表示启动了进程，不表示加载或验证通过。参数和配套产物要求见 [本机查看器](docs/local-viewers.md)。

## 文档入口

| 你要做什么 | 阅读 |
|---|---|
| 让 Agent 正确调用工具 | [随 MCP 分发的工具指南](src/eda_harness/server/tool-guide.md) |
| 打开网表图、波形、版图或 DRC/LVS 数据库 | [本机查看器](docs/local-viewers.md) |
| 查工具参数和资源 | [自动生成的 MCP 接口](docs/mcp-tools.md) |
| 安装、选择项目、接入客户端 | [安装与接入](docs/installation.md) |
| 配置 action、后端和输入 | [EDA 操作与配置](docs/semantic-api.md) |
| 了解快照、缓存和验收机制 | [架构与扩展契约](docs/architecture.md) |
| 查看已验证与未完成部分 | [能力状态](docs/v1-status.md)、[验收记录索引](docs/validation.md) |
| 查版本 | [Python 依赖锁](docs/dependency-locking.md)、[软件版本盘点](docs/dependencies.md) |
| 开发或更新文档 | [开发与文档维护](docs/development.md) |

更多资料见 [文档目录](docs/README.md)。
