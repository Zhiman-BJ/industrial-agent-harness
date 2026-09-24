# Chip Pack v0.6.0-preview.1

独立的无 UI 芯片领域包。下载本 Release 的 `.tar.gz` 和 `.sha256` 文件；按包内 [README](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/main/domain-packs/chip/README.md) 安装。安装需要 `uv` 和网络，用固定版本安装 EDA Harness Python 依赖与 Kimi CLI 1.51.0；MCP 服务源码、Skill 和工具镜像构建文件已经在下载包中，不需要访问私有 EDA Harness 仓库。

## 相对原生 Kimi Code 提供什么

- EDA Harness 0.6.0 的**完整 25 工具 MCP 服务**，通过 stdio 提供项目状态、环境检查、动作提交、运行查询、诊断、指标、内容寻址产物、状态比较及验收目标管理。
- `eda-core` Skill 与绑定到指定项目的 Kimi MCP 配置生成器。安装和绑定不会修改全局 Kimi 设置。
- EDA Harness 持久化 Core 与 Runtime：`run_action` / `run_until` 提交真实 EDA 作业，`get_run`、产物与验收结果用于核对执行和工程结论。
- 锁定的 Python 依赖和固定 Kimi CLI 版本；安装脚本创建包内隔离环境。MCP 工具的实际注册和 `get_server_info` 调用在发行流水线中通过真实 stdio 连接验证。
- Dockerfile 和工具检查命令，可自行构建包含 Verilator、Yosys、OpenROAD、KLayout、Magic、Netgen LVS、GTKWave 的计算镜像。

## 与 Industrial Core 的边界

- 这是**独立 Domain Pack**，目前没有自动装入无 UI Core 的 Capability Broker，也不受其动态 Scope allowlist 管理。需要先测试芯片场景时，可以直接使用此包和 Kimi 的原生 MCP 配置；不能据此宣称 Industrial Core 的垂直闭环已完成。
- Release 包含 MCP 源码和安装方法，**不包含预构建 EDA 工具镜像、PDK 或项目输入**。真实仿真、综合和物理流程需先构建镜像并配置项目；CI 只验证 MCP 和适配器，不宣称这些工业动作在所有平台通过。
- Kimi SDK 位于独立的 Headless Core Release；此包安装 Kimi CLI，与 Core Broker 尚未接通。

[Headless Core v0.1.0-preview.1](https://github.com/Zhiman-BJ/industrial-agent-harness/releases/tag/headless-v0.1.0-preview.1) 单独提供 Broker 与 Kimi SDK 接入；当前 Chip Pack 的 MCP 应按本页作为独立服务使用。
