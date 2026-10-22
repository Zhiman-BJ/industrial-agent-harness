# 全仓分析与优化记录

> 历史记录：本页 CLI/专用 SDK 与 headless 示例对应当时提交，已按 PD-096 退役；当前 GUI 验收入口见 [QA 手册](qa-runbook.md)。
2026-10-03，基于 `587b75d` 分析整个 `industrial-agent-harness` monorepo：Desktop、CLI 两个入口、11 个共享包，以及领域包、构建脚本、测试和 CI。本次已落实性能、代码风格、内部命名和职责拆分的优化，并修复回归中发现的并发与 Viewer 生命周期问题。产品功能、公开工具 ID、领域注册、审批语义和工程验证范围保持原有契约。

仓库当前可运行的是 Workbench MVP。完整 Industrial Core Vertical Slice 的缺口仍以[现状与缺口](01-current-state-and-gaps.md)、[架构不变量](02-architecture-invariants.md)和 [Prototype Register](prototype-register.json) 为准；本次没有把这些缺口扩展为新功能。

## 模块分析与已落实改动

| 模块 | 分析结论与本次处理 |
| --- | --- |
| `apps/desktop` | `main.cjs` 同时处理宿主、文件边界、IPC 和自测，`App.tsx` 同时处理项目、聊天和 Viewer。抽出可独立验证的 `project-files.cjs` 与 `agent-events.ts`；保留宿主授权和运行时装配位置。流式展示事件按约 16 ms 合批，历史轮次保留引用，文件树与项目运行数复用计算。 |
| `apps/cli` | 参数、MCP 管理、日志和 bench 已分文件，共享入口主要依赖 Core。保持现有命令、JSONL 输出与退出语义，统一格式；打包、Scope、恢复及外部 MCP 由既有测试约束。 |
| `agent-kimi` | 日志索引逐块拼接长记录产生大量重复复制；追加后统计与详情查询也反复遍历。改为分片收集、完整记录只拼接一次，计数增量更新，序号直接定位，详情用 ID 索引，UTF-8 分页复用一个字段的编码。固定 SDK/CLI、脱敏和快照校验保持原有规则。 |
| `harness-core` | 禁用 MCP 策略在每个 Capability 中重复枚举 Provider；SQLite 高频查询重复 prepare。改为每次策略解析只枚举一次、按 Domain 建立 Tool Set；数据库复用语句并补充运行锁及会话查询索引。跨请求配置仍重新读取。 |
| `capability-broker` | 确定性过滤、Scope 替换与渐进披露已有职责边界。未引入跨请求缓存，避免项目策略或安装资源变化后返回旧 Scope；统一格式并保留 Trace 测试。 |
| `domain-mcp` | 直接注册与 Gateway 的筛选语义不同：前者要求完整工具集合，后者取 Scope 交集。只将成员查询替换为 Set，保持两个语义及顺序；外部 MCP 配置、schema、快照和调用检查保持原有边界。 |
| `domain-runtime` | 文件观察与 Godot 的 ActionJournal 已存在，尚不构成完整工业验收闭环。保持现有哈希观察、Action 记录和验证边界，统一格式。 |
| `domain-skills` | 包发现、注册、资源来源与安装状态已有独立模块。保留每次加载的文件观察和固定资源来源，未建立会导致安装或修改后陈旧的全局缓存。 |
| `pack-manager` | 下载、签名、哈希、路径检查及原子安装均属于高约束路径。保持行为，运行原有边界测试；未改动发行协议、信任配置和固定资源。 |
| `computer-use-bridge` | 队列中等待者超时曾立即释放队列，可能让后续调用越过仍在执行的桌面动作。超时只结束等待者，队列在前序动作真正完成后释放；补充能在旧实现中失败的回归断言。 |
| `viewer-core` | 注册表匹配时重复复制插件 Map。注册时保存有序插件列表，匹配复用；保持插件优先级和公开注册契约。 |
| `viewer-builtin` | 所有 Viewport 进入首屏包，导航状态更新还会先清空控制器。八类 Viewport 改为按需加载，保留加载/错误状态；导航更新只发布新状态，卸载时清理。全屏继续复用已挂载视图。 |
| `contracts` | Scope、Context、观察与 Verification 的概念已有明确区分。保持契约形状和 canonical ID，统一格式，运行契约与架构测试。 |

切换文件时还发现一个生命周期问题：新的 Artifact 已选中，但上一文件的 Viewer 仍会短暂以新 key 重挂载，其 Ready 回调可污染新文件状态。现在仅渲染 Artifact ID 与当前选中 ID 相同的已打开 Viewer。KiCad 缩放恢复和 Godot/工程文件切换回归验证了该修复。

展示合批只作用于渲染器。主进程仍逐个持久化原始事件；审批、问题、结束和错误事件立即刷新，后台聊天的事件不会合并进当前聊天。抽出的合并函数保持输入不可变，并在工具与其他活动边界保留事件顺序。

## 性能证据

同一台 macOS arm64、Node `v25.9.0`，合成基准重复 5 次取中位数。可复现脚本为 `scripts/benchmark-maintenance.cjs`，原始结果见[基准数据](repository-optimization-benchmark.json)。这些数值描述特定路径，不能推导为整个产品的速度提升。

| 检查 | 优化前 | 优化后 | 含义 |
| --- | ---: | ---: | --- |
| 约 8 MiB 日志索引读取 | 41.13 ms | 6.38 ms | 此样本约 6.4 倍加速 |
| 每次索引读取的 Buffer 拼接复制量 | 549,435,692 B | 8,388,853 B | 减少约 98.5%；这是累计复制量，非进程峰值内存 |
| 200 个 Capability、10 次禁用策略解析 | 1,085.78 ms | 7.98 ms | 此样本约 136 倍加速，主要来自 Provider 枚举从循环内移到循环外 |
| 1,000 段聊天写入与恢复 | 54.56 ms | 51.61 ms | 差异较小，不据此声称稳定显著收益 |
| 桌面首屏主 JS 包 | 322.00 kB | 277.05 kB | 减少约 14%；其余 Viewer 在首次打开时加载 |
| 桌面首屏主 JS 包 gzip | 97.77 kB | 85.05 kB | 减少约 13% |

按需加载减少首屏载荷，不表示所有分块总大小等比例下降。记录扫描仍执行 JSON 解析，语义投影仍受现有有界缓存控制；本次没有把这些路径改成另一个日志协议或存储引擎。

## 代码风格、命名与可维护性

源码、测试和维护脚本使用固定版本 Prettier `3.6.2`，新增 `format` / `format:check`，CI 在架构检查前执行格式门禁。单引号、100 列换行和统一缩进取代大量单行压缩代码。大部分文件差异来自格式化；格式改动曾通过去除位置信息、注释和 JSX 等价空白的 AST 对照检查，并由原有测试继续约束行为。

上游与发行资源不参与格式化：`domain-packs/chip/eda-harness`、vendor、fixtures、public、构建输出及固定 Surfer 生成文件保持原样。未改动领域工具 ID、Skill ID、Prototype Register 或产品数据格式。

`App.tsx` 中含义模糊的内部状态改为 `selectedArtifactId`、`openedViewer`、`selectedArtifact`、`activeFileName`、`isViewerReady` 和 `capabilityDetail`；聊天选择明确使用 `selectedChatId`。日志投影中的 `p` 改为 `sdkPayload`。命名调整限于内部符号，IPC 字段、公开导出和持久化键保持兼容。

抽取只覆盖职责明确且有独立验证价值的部分：项目文件访问和展示事件合并。没有把所有文件重新分层，也没有复制另一套 Agent loop、Broker、Domain Runtime 或网关。

## 验证与边界

- 架构边界检查：12 项通过，冻结工具面、无 UI 依赖、运行时层次和资源来源检查均保留。
- 全仓常规测试：166 项，其中 162 通过、4 项因未显式指定可选原生运行时而跳过。随后使用本地固定 Kimi CLI 与 KLayout 补跑，7 项通过，覆盖上述 4 个可选场景。
- 真实外部 MCP 的 stdio / HTTP / SSE、固定 Kimi 调用和跨进程聊天恢复集成：6 项通过。
- 共享 Domain MCP 集成：11 项中 9 项通过，涵盖真实 Chip/Kimi、Scope 与 PCB MCP 传输；2 项依赖额外的固定 PCB-bench 源码 checkout，因本次未配置而明确跳过。
- TypeScript 检查、桌面生产构建、源码格式门禁和差异空白检查通过。
- macOS Electron：通用文档、工程文件、KiCad、真实 Godot Web Export、Agent 日志、并行聊天及应用重启恢复检查通过；综合自测还验证了项目/资源策略、网表、真实 KLayout 版图、Surfer 波形、缩放/Fit/全屏和设置流程。
- GUI FIFO 回归在修复前失败、修复后通过；项目文件边界、短读、文本截断、Viewer 延迟读取，以及展示合批/不可变性有针对性测试。

本次没有进行真实工业任务的完整工程验收，也没有重新执行 Windows/Linux 打包、签名安装和 OTA。已有原型约束与发行边界保持文档中的状态。

## 后续优化优先级

以下是评审结论，未在本次新增实现：

1. **P1：继续拆分宿主装配与页面编排。** `main.cjs` 和 `App.tsx` 仍偏大。后续可按已有 IPC 组和页面生命周期拆分，每次由一个完整已有用户流程约束；应遵循架构不变量，避免把领域执行继续塞进 Adapter。
2. **P1：补充真实负载剖析。** JSON 格式识别、首次语义日志投影和大 Pack 解压仍可能占用宿主线程。先记录真实文件大小、耗时和内存，再决定 worker 或流式处理；合成基准不足以证明它们都是当前瓶颈。
3. **P2：收敛自测装配。** 综合 Viewer 自测位于 `main.cjs`，部分断言落后于当前资源目录与通用文档 Viewer。此次按实际目录数量和 Markdown 渲染更新断言；后续可与现有独立自测模块统一入口，减少产品宿主文件中的测试编排。
4. **P2：沿既有路线替换冻结原型。** 完整 Core 工业状态闭环属于现有路线图的功能开发，应另行按 Vertical Slice 验收，不混入本次维护优化。

## 复现

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm test:architecture
pnpm test
pnpm --filter @industrial-agent-harness/desktop build
pnpm test:external-mcp
pnpm test:chat-resume
pnpm benchmark:maintenance
```

原生运行时和桌面自测的准备与入口见 [Desktop](../apps/desktop/README.md)、[Agent adapter](../packages/agent-kimi/README.md) 和各 Viewer 文档。合成基准建立独立临时目录并在结束后清理，不读取真实聊天或工程数据。
