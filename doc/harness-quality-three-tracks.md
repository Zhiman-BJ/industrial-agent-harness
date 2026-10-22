# 三轨整改与验收范围（2026-10-04）

> 历史记录：本页 CLI/专用 SDK 与 headless 示例对应当时提交，已按 PD-096 退役；当前 GUI 验收入口见 [QA 手册](qa-runbook.md)。
> 2026-10-20 执行政策更新：本页保留当时实现与验收记录。文中本机 Agent 的 Seatbelt/bubblewrap、工程只读或平台拒绝启动要求已由 [PD-088](local-agent-execution.md) 取代，当前三平台 Agent 均使用当前用户权限；声明式 Runtime 任务及远端沙箱隔离保持。历史实测结果不改写，也不代替新模式的平台验收。

这轮改动按 P0、P1、P2 分工，接入真实 CLI 和 Desktop。此前的架构评审保留为历史基线；本页记录新增实现及其边界。平台仍处于 Workbench MVP，首条 RTL 持久化闭环已实现；其他领域的完整工业内核仍需持续推进。

| 优先级 | 已交付                                                                                                                                                                          | 验收入口                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 根 MIT、第三方清单、安全报告入口；真实 Kimi 写入边界；状态驱动 Broker；Runtime 持久化 Run/Action/Artifact/Verification/State/Checkpoint；真实 RTL、失败路径、陈旧输入和重启恢复 | `tests/integration/industrial-core-vertical-slice.test.cjs`、`tests/integration/industrial-core-installed-pack.test.cjs`、`packages/domain-runtime/tests/industrial-recovery.test.cjs`、`packages/agent-kimi/tests/process-sandbox.test.cjs` |
| P1     | v1 工业契约及 TypeScript 声明；完整 Skill 资源；安装完整性回执；原子替换与失败升级保留旧版；外部 Pack 示例和作者教程                                                            | `scripts/check-pack-release.cjs`、[契约版本](contracts-versioning.md)、[Pack 教程](pack-authoring.md)                                                                                                                                        |
| P2     | Node SDK、stdio JSON-RPC；取消/超时回收后代；原生 Kimi/Harness 配对入口；独立 RTL 验收与输入、实现、轨迹摘要；CLI 工件读取和桌面 Runtime 生命周期抽取                           | `packages/sdk/tests/`、`tests/benchmark/`、[SDK](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/39d7d3057b2b7ebe7db22ee72e9ced86d81b2776/doc/sdk.md)、[评测基线](benchmark-baseline.md)                                                                                                                                                  |

## 工程结果

CLI 的 `industrial_result` 返回规范工业事实。最终 `result.status` 表示 Agent 回合状态，`result.engineering.status` 表示当前工程状态。Desktop 单独显示工程验证；工具执行完成后可能验证失败、证据不足或输入已陈旧。进程返回零、模型回答成功和 Viewer 正常展示不能建立工程验收。

真实执行先读取 StateProvider 的输入摘要和阶段，再解析 Broker。执行边界重新检查项目、领域、状态身份、工具范围和审批。修改源码会使当前证据失效；历史产物和检查点保留。重开 Runtime 会将未完成动作恢复为失败及证据不足，不自动重放。

`--scope-only` 是无模型、无原生工具依赖的注册预览，输出 `preview:true`、`executionAuthorized:false`。它可检查发行物安装；真实 `run` 会依据工程状态重新分配工具。

## 发行与扩展

源码、安装态和会话都携带 Skill 的附属文件。缺资源、越界、软链、超限、篡改及不兼容版本会被拒绝。公开 PCB 包保留桥接 Skill 和固定来源声明；完整私有正文由授权的固定 checkout 提供。外部开发者可按教程独立构建 `.hpack`，无需向 Core 增加领域分支。

Headless、Chip Pack、Domain Pack 和 Desktop staging 携带根许可证与第三方清单。桌面另携带 Viewer、字体许可证和源码构建来源。MIT 覆盖自有贡献，各第三方保留原许可；私有来源的公众复用授权独立记录。

2026-10-04，所有者确认本仓引用的 EDA Harness 与 EDA Harness demo 自有代码也采用 MIT。EDA 子树携带独立许可证；demo 的组件和示例授权记录在[来源页](agent-ui-provenance.md)。其他外部工具、字体和渲染器继续保留原许可。

CI 明确运行架构、完整 Pack 发行校验、配对工程 smoke 及 macOS 原生工业闭环。原生 gate 的测试文件或依赖缺失会失败。远端执行结果以关联 PR 的检查状态为准；新增门禁不等于已配置 GitHub 分支保护，本轮不发布新版本。

## 本轮验证记录

本机环境为 macOS arm64、Node 25.9.0、pnpm 11.1.3、Python 3.13.13、Kimi CLI 1.51.0、Verilator 5.052。以下结果来自本地运行；新增 GitHub CI 尚未在远端运行。各组有重叠，不累加为总测试数。

| 检查                                                   | 结果与边界                                                                                                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全仓 `pnpm run test`，显式提供固定 Kimi 可执行文件     | 206 项：205 通过、0 失败、1 跳过；跳过的是缺少 KLayout 原生环境的可选 Viewer 渲染                                                                                                         |
| `pnpm run test:architecture`                           | 12 项通过；通用 Core/Broker 不引入具体领域或桌面依赖                                                                                                                                      |
| `pnpm run test:release`                                | 17 项通过；包含外部作者 Pack、四个内置 Pack、完整资源、失败升级及严格 TypeScript 消费检查                                                                                                 |
| `pnpm run test:industrial-core`，原生依赖缺失视为失败  | 7 项通过、0 跳过；真实 Verilator、CLI/Kimi 调用链、安装态库存与同版本签名修复                                                                                                             |
| P0 Runtime、恢复、进程隔离、许可及旧 Kimi 集成组合回归 | 17 项通过、0 跳过；包含前述 Core 项，覆盖取消、超时、拒绝、陈旧输入及重启                                                                                                                 |
| 外部 MCP 兼容性与传输集成                              | 5 项通过、0 跳过；启用时明确拒绝受保护会话，停用后真实 Kimi 会话可恢复，stdio/HTTP/SSE 传输另行通过                                                                                       |
| 其他 Domain MCP 集成                                   | 10 项通过、2 项因未配置私有 PCB actor checkout 跳过；不据此声明私有 PCB 完整写入验收                                                                                                      |
| SDK 与配对评测                                         | SDK 9 项、评测 8 项通过；实际入口使用受控本地提供方，未花费模型 API 费用，未产生正式能力排名                                                                                              |
| Desktop                                                | 类型检查与构建通过；真实 Electron 多会话/停止/重载/退出检查通过；本地未签名 arm64 `.app` 验证首次启动、Chip/PCB 首装和 Godot/CAD 补装；实际 `app.asar` 含根许可、第三方告示及 Viewer 许可 |
| 格式与差异                                             | `pnpm run format:check`、`git diff --check` 通过                                                                                                                                          |

桌面安装包的启动及 Pack 安装验证，与 Core 测试中的真实工业验收分开记录。未签名本地 `.app` 不是已发布、已公证或三平台合格发行物。

全部改动位于 `codex/harness-quality-three-tracks` 的独立工作树，基于 `origin/main` 的 `d41630a`，通过 PR 提交评审。原工作树 `codex/chip-runtime-reliability-0.6.1` 的 Linux 安装器工作保持原状，不包含在本次提交内；本轮不发布安装包或新版本。

项目首页同步提供 [English](../README.md) 与[简体中文](../README.zh-CN.md)，两版明确标注开发者预览版，说明当前源码、历史归档及第三方许可范围。文档核对覆盖 131 个本地链接、5 组一致的双语命令示例，以及实际无模型 CLI 预览。

## 后续范围

- 当前工业 Agent 写入边界为 macOS Seatbelt。Linux/Windows 的真实工业 Kimi 执行明确拒绝启动；注册、离线预览和桌面显示另行验证。
- Kimi 在稳定的隔离会话目录中运行，读取绑定工程；宿主 Runtime 执行工程写入。外部 MCP 应用服务无法与受保护会话同时启用；Computer Use 插件已声明 `protectedSafe` 并在受保护会话放行（宿主侧执行、启用即授权、调用记诊断日志，2026-10-12 起）。旧 Domain MCP 的写操作也会被系统拒绝。其他领域的写工具仍需接入 Runtime。
- RTL 验收覆盖已声明测试台的断言、仿真结束和真实 VCD。覆盖率充分性、物理实现资格及完整工业签核仍需独立验收。受控本地模型验证了真实工具传输链，不提供模型能力结论。
- 配对 runner 的正式模型成功率和成本比较尚未运行。固定模型、环境及多任务试验仍需采样；缺 token/价格证据写 `null`，seed 控制执行顺序，预算只强制墙钟时间。
- 宿主已抽取工件读取和项目 Runtime 生命周期；大型 Electron 入口与 App 的进一步拆分仍需推进。

详细边界见 [P0 工业闭环](p0-industrial-runtime.md) 与 [安全边界](../SECURITY.md)。
