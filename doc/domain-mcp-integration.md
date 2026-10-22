# Chip Pack MCP：Desktop 共享接入

> 2026-10-20 执行政策更新：本页保留当时实现与验收记录。文中本机 Agent 的 Seatbelt/bubblewrap、工程只读或平台拒绝启动要求已由 [PD-088](local-agent-execution.md) 取代，当前三平台 Agent 均使用当前用户权限；声明式 Runtime 任务及远端沙箱隔离保持。历史实测结果不改写，也不代替新模式的平台验收。

2026-10-04 边界更新：受保护 Kimi 的原生 Shell 和旧 Domain MCP 子进程无法写入工程。下面的工具声明、注册和历史传输证据仍保留；旧修改操作目前被拒绝，初始化会写工程的旧 MCP 也可能无法启动。新声明式 RTL 仿真经宿主 Runtime 执行，见[P0 工业闭环](p0-industrial-runtime.md)。`--scope-only` 仅做注册预览。

2026-09-29 已注册 `chip-pack.eda`；2026-10-03 更新为 EDA Harness 0.6.1，Python MCP SDK 固定为 1.29.1。
2026-10-03 本地修复包升级为 `0.6.1`，Python MCP SDK 仍为 1.29.1。
Chip 源码摘要同步更新；容器清理、资源预算、编译与证明边界见 [运行时修复](../domain-packs/chip/eda-harness/docs/runtime-reliability.md)。
注册清单位于 `packages/domain-skills/packs/chip-pack.json`，包含完整 25 工具映射、风险、验证要求和五组 Capability。
原有四个只读 Viewer 检查 Capability 保持原范围；新领域包声明通过校验后合入共享 Registry。

## 使用

仓库开发环境在 `domain-packs/chip/eda-harness` 执行：

```sh
uv sync --frozen --no-dev --python 3.13
```

UI 的 Settings → MCP & Skills 和 Chip 项目详情页显示 Chip Pack，默认启用。全局默认值、项目覆盖和继承仍共用已有策略。
CLI 使用相同策略；无需添加专用适配器或修改 `~/.kimi`：

在桌面新建 Chip 项目并发送任务；注册、禁用与恢复通过能力设置和共享应用层集成测试核对。

真实 Agent 任务仍需模型配置、API key 和固定 Kimi CLI。CLI 默认拒绝审批；`--approval approve` 仅用于显式选择自动批准的运行。
未创建 `eda.yaml` 时仍可检查服务身份和环境；初始化任务才允许 `initialize_project`。注册成功不代表 Docker、镜像、PDK 或工程输入已就绪。
芯片执行依赖的完整说明见 [Chip Pack](../domain-packs/chip/README.md)。

Headless 打包同时携带注册清单、Gateway、领域 Skill 和固定 Chip Pack 源码，不携带本机 Python 虚拟环境。下载/解包后仍要准备上述 Python 环境。
也可使用用户配置的绝对路径 `INDUSTRIAL_HARNESS_CHIP_PACK_DIR` 指向 Chip Pack 根目录，`INDUSTRIAL_HARNESS_EDA_PYTHON` 指向它的 Python。
源码摘要、包版本、MCP 依赖、进程 Python、实际导入目录和完整 tools/list 必须符合声明；同版本的修改源码也会拒绝。

## 调用链与披露

Desktop → 共享资源策略和 Broker → 当前 Scope → Kimi 独立会话 mcp.json → Python MCP Gateway → EDA Harness MCP → 已有 EDA Runtime。

Gateway 使用依赖锁中的官方 MCP ClientSession、stdio transport 和 FastMCP；不自建 Agent loop 或工业运行时。
它只向 Kimi 提供四个固定工具：

| 工具                      | 功能                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `domain_tool_list`        | 当前 Scope 的 canonical ID、摘要、风险，不加载所有参数 schema               |
| `domain_tool_describe`    | 加载一个允许工具的上游 schema；项目路径由 Harness 绑定                      |
| `domain_tool_call`        | 校验范围与参数后调用；例如 `eda.harness.run_action` 映射到上游 `run_action` |
| `domain_tool_result_read` | 分页读取本会话内较大的原始响应                                              |

检查、初始化、执行、历史和外部 Viewer 启动按任务选择不同 Scope。执行组包含读取、初始化、目标/决策和 Run 管理；历史 checkout 与外部 Viewer 启动需要各自任务范围。
get_operational_context 返回的是 EDA 持久化上下文；Core 的 SQLite 文件观察继续明确标为 `not_run`。模型压缩与会话持久化仍由 Kimi 管理。

## 执行边界

Gateway 对 describe 与 call 都检查固定的当前 Scope；模型参数不能增加权限。项目路径由调用层注入，拒绝另一项目的 project_path；额外参数如 approval 通过上游 JSON Schema 拒绝。
全局/项目 MCP 禁用会在 Broker 解析前移除相应工具，两个入口随后都不生成该服务器配置。Scope 或运行时目录改变会更换 Kimi 会话兼容性键。
正在执行的会话不能改变资源配置，切换项目不会改变后台会话的绑定。Gateway 每次调用重新检查项目路径，退出时 Kimi Code 服务清理 stdio 子进程；已提交 EDA 作业遵循领域运行时自己的生命周期。

固定 Kimi Code 2.1.1 的 manual 模式对 MCP 调用请求审批，UI 使用原有审批条目，CLI 使用原有 approval policy。
工业动作始终由 EDA Runtime 执行。Gateway 45 秒调用超时不重试；超时可能已经提交，先检查 existing runs。Run SUCCESS 与 acceptance PASS 分开处理。

参数限制 64 KiB，单次输出 16 KiB；较大响应保存在独立会话目录，缓存总量与单响应上限 4 MiB。返回 responseId、大小与摘要，再按字符 offset 读取最多 8000 字符，并再次限制 UTF-8 输出大小。
缓存重启后失效，达到容量上限时淘汰旧响应；不把截断内容当作完整结果。超过单响应上限的变更结果必须通过已有 Run 查询恢复，不能直接重提。
政策/缓存目录 0700、文件 0600。MCP 文本分段在聊天中保留；非文本内容给出类型提示，原始 SDK 事件保留完整记录。

## 实际验证与限制

- Node 单元与架构检查：声明、风险、旧检查 Scope、项目资源策略、失败与文本分段。
- `pnpm test:mcp`：真实 MCP stdio、固定 Kimi CLI 和真实 CLI 命令；越权 describe/call、跨项目与额外参数拒绝；完整大响应分页与摘要；审批批准后目标持久化与上下文回读；拒绝无变更。
- `pnpm --filter @industrial-agent-harness/desktop test:mcp`：macOS Electron 真实资源页面、禁用/继承、真实 Kimi MCP 审批和工具调用、目标与上下文回读。
- Kimi 验证使用本地受控模型响应驱动确定性工具调用，不声称真实模型推理能力；不运行工业仿真/综合/物理验收，不宣称 Core Vertical Slice 已完成。
- Linux / Windows 安装包链路尚未实测。该网关提供调用范围与项目参数约束，并非操作系统沙箱；EDA 源码/配置、Python 环境和运行时仍需可信部署。
