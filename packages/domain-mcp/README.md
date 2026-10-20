# Domain MCP

Exposes compact discovery, selected tool schemas, and scoped calls backed by a declared domain Runtime.

当前工业调用通过宿主 scoped `industrial_action_call` 进入规范 Runtime，保留项目、状态、工具范围和审批检查。显式注册外部 MCP 也经由宿主 Runtime 审批与持久 Action/响应执行；外部响应仍未验收。[PD-088](../../doc/local-agent-execution.md) 已将三平台本机 Kimi 统一为当前用户权限，原生工具和子进程不再继承只读工程的 OS 限制。移除该限制不使遗留 Gateway mutation 自动获得 Runtime 授权或工程资格。下文保留 Gateway 注册/传输 API；历史 P0 实测见 [P0 工业运行时](../../doc/p0-industrial-runtime.md)，当前权限见[安全说明](../../SECURITY.md)。

`listToolProviders` 生成领域工具资源目录，优先读取当前 Runtime factory 的实际 ToolDescriptor 注册，并包含外部 MCP 发现结果。稳定资源 ID 用于全局默认与项目覆盖。该目录用于 UI 和共享权限策略，不生成独立 MCP 子进程。

`listMcpServers` 只生成独立 MCP 服务清单；保留 Runtime 提供方过滤。旧版 Pack 同时保留独立 MCP 声明时，资源目录通过 `standaloneMcp` 分开展示这套声明与当前 Runtime 工具。目录数量取决于当前 Pack 版本和配置，不能用历史 Chip 25 / PCB 89 / Godot 5 的 MCP 声明数量代表当前任务可调用数量。核对数据及权限/界面验证见[领域工具资源](../../doc/domain-tool-resources.md)。
受控 Gateway 只披露 discovery/describe/call/result-read 四个工具，在真正调用时校验范围、项目路径和参数。普通直连 provider 仍要求全部声明工具在 Scope 内。

注册数据来自仓库校验过的 Domain Pack 清单；项目只能保存稳定资源 ID 的启用策略，不能添加任意启动命令。配置 UI 提供全局默认与项目三态覆盖。缺少依赖时返回安装路径指引，不自动安装软件，不修改用户全局 Kimi 设置。

共享网关、安装、分页与真实验证见 [Chip Pack MCP 接入](../../doc/domain-mcp-integration.md)。

`ExternalMcpRegistry` 是显式用户注册的独立入口，保存在用户私有配置目录；项目不能自行提供启动命令。支持 stdio、Streamable HTTP、SSE 和凭据环境引用。Desktop / CLI 共用注册快照与策略；受保护会话的发现/describe/call 由宿主 Runtime callback 提供，完整响应通过 immutable artifact 分页。旧 Gateway 保留协议测试。实际调用标为 mutating，经 Runtime 审批，调用前重查 Scope、参数、注册 revision 和 live 工具快照；图片保持 ImageContent，文字有界、分页并脱敏。外部 host 服务不产生工业验收事实，roots 不是 OS 沙箱。行为、限制与测试见 [外部 MCP](../../doc/external-mcp.md)。

Domain Pack 中 `transport: runtime` 的宿主工具提供方由 Domain Runtime 加载，不进入 MCP server 清单或子进程配置。FreeCAD 通过这一边界复用持久执行与审批，见 [FreeCAD CAD Pack](../../doc/freecad-domain-pack.md)。
