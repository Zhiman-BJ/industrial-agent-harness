# 领域工具与 MCP 资源展示

2026-10-14，问题 #155。

项目详情与能力中心的「领域工具与 MCP」展示当前加载 Pack 的工具提供方、版本、接入方式、工具数量、名称、canonical ID 和用途。搜索覆盖提供方及工具名称、ID、用途；无搜索结果与尚未注册提供方使用不同提示。

目录来自可信 Runtime factory 的实际 ToolDescriptor 注册，不执行工具、启动原生程序或探测服务连接。旧版 Pack 如果同时保留独立 MCP 通道，其 manifest 工具在独立折叠列表中显示，不能当作当前 Runtime 工具数。没有配置 CUDA 端点时，其 Runtime 可能注册零个工具；界面保留提供方并提示检查领域配置。

启用是访问策略，不代表软件依赖、远程连接或工程任务已经通过验收。就绪状态继续由运行诊断与领域安装管理提供。项目只显示其领域及显式注册的外部 MCP；全局目录显示全部已加载提供方。一个提供方加载失败会显示明确错误，不隐藏其他领域，也不向 UI 暴露包含环境值的 factory 异常。

## 当前本地工作区核对结果

在原 `industrial-agent-harness-auth` 工作区加载的 Pack 上核对：

| 领域          | 提供方                  | Pack 版本     | 当前 Runtime 工具数 |
| ------------- | ----------------------- | ------------- | ------------------- |
| Chip          | `chip-pack.runtime`     | 0.7.0         | 2                   |
| Godot         | `godot.local`           | 0.2.4         | 2                   |
| PCB           | `pcb.design.tools`      | 0.3.1         | 90                  |
| CAD / FreeCAD | `freecad-local.runtime` | 1.1.4-pack.11 | 7                   |

这份工作区未加载 CUDA Pack。以上四个提供方均通过 Runtime 接入。工具数随实际加载版本和配置变化，产品代码不硬编码此表。完整列表从当前目录导出为验证附件。

- Chip：`chip.rtl.verify`、`chip.environment.check`。
- Godot：`godot.scene.edit`、`godot.scene.verify`。
- CAD：`cad.freecad.build`、`cad.freecad.inspect`、`cad.freecad.export`、`cad.freecad.edit`、`cad.dxf.create`、`cad.dxf.inspect`、`cad.dxf.verify`。
- PCB：`pcb.kicad.edit`、`pcb.kicad.verify` 与 88 个 `pcb.design.*` 工具，涵盖工程、元件、网络、原理图、板图、布局布线、ERC/DRC、核验及导出。实际名称可在 UI 展开或搜索。

本次源代码的冻结依赖回归另覆盖较早 Pack 清单：Chip 2 个 Runtime 工具加 25 个独立 MCP 声明，Godot 2、PCB 91、CAD 4、未配置 CUDA 0。两种目录均按真实 Runtime 注册生成，不把版本差异当成同一份能力。

## 共享 API 与权限

`listToolProviders(domain, external, options)` 生成用于资源展示和策略的目录；`listMcpServers`、`selectMcpServers` 和 `writeMcpConfig` 继续只管理独立 MCP 配置，不为 Runtime 提供方生成子进程条目。

`resourceCatalog` 接受加载的 registry、项目 Runtime bundle 与执行环境。共享 TaskService 用同一目录读取全局默认和项目三态覆盖（继承、启用、禁用），在 Broker 中过滤当前 Runtime 的实际工具 ID；提供方声明的工具（包括当前 profile 尚未注册的条目）和旧独立 MCP 声明同样遵守该提供方的禁用设置，不会因目录只显示实际注册工具而漏过策略。运行边界仍复核 scope。Desktop 的资源策略 callback 接收 TaskService 已生成的目录，避免使用不同的项目 profile。

切换项目或重新加载目录后，过期的读取与保存响应不会覆盖新项目。资源策略修改延续现有空闲会话与重置约束，外部 MCP 添加/删除会刷新当前目录。

## 验证入口

- `pnpm test:architecture-contract` 与 `pnpm test:architecture`。
- Domain MCP、Harness Core 和 TaskService 现有套件；新增实际 Runtime 注册、配置隐私、越界入口、提供方隔离、旧 Gateway 清单、项目 profile 和全局/项目策略回归。
- TaskService 回归验证禁用后的实际 Runtime 调用失败，项目显式启用后同一工具可执行并记录 Action。
- `pnpm --filter @industrial-agent-harness/desktop build`。
- `pnpm --filter @industrial-agent-harness/desktop test:mcp`：原生 Electron 全领域目录、工具明细/搜索、资源覆盖、中文、主题、小窗口，以及真实固定 Kimi 的受控模型/审批链路。
- `pnpm --filter @industrial-agent-harness/desktop test:external-mcp`：外部服务添加/删除刷新与原生调用链路。

本次 UI/权限验证不扩大原生工业软件、远程端点或打包发行的平台验收范围。

## 本次本地验收结果

2026-10-14，macOS arm64：架构回归 48/48、Domain MCP 20/20、Harness Core 37/37、TaskService/成果套件 18/18、重点目录与策略回归 31/31 通过；真实 Verilator 工业内核闭环 9/9 通过（按 uv.lock 准备了 Chip Python 环境）。Desktop 构建与类型检查通过。

原生 Electron 的 MCP/资源流程分别在源码冻结的五域目录和原工作区现有四域 Pack 上通过，包括真实固定 Kimi、审批、全局/项目策略、工具明细、搜索、中文深色及 640×480 窗口。外部 MCP 的添加、删除刷新、真实原生调用和忙时拒绝修改流程通过。

修复在独立本地分支 `codex/domain-tool-resources-ui-20261014`；截图和工具目录保存在项目的 `outputs/mcp-ui-155-20261014/`。此记录确认本地源码验收，不代表已发布安装包。
