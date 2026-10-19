# 架构决策记录

本页区分当前已确定的方向、两份计划中的建议和仍需实测的接口。计划材料是设计输入，不是对现有实现的描述。

Project、Domain 和 Session 的用户交互决定见[产品决策记录](product-decisions.md)。

## 已确定

| 决定                                                   | 当前落实情况                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Electron 桌面端面向 Linux、macOS、Windows              | macOS 桌面 MVP 已运行；三平台打包尚未验证                                                                                                                                                                                                                          |
| 第一阶段使用 Kimi Code，不自研 Coding Agent            | `packages/agent-kimi` 精确依赖 `@moonshot-ai/kimi-code@2.1.1`，使用本地公开 Server API；旧 CLI 的 27B 测评为历史证据                                                                                                                                               |
| Kimi 接入尽量非侵入                                    | 不把上游整仓作为 submodule；优先使用公开接口                                                                                                                                                                                                                       |
| Monorepo 分离 UI、领域 Skill、领域 Runtime、MCP 等职责 | UI、Viewer、Broker、Kimi 和首批 Skill 声明已实现；Domain Runtime 只有只读观察状态与最小 Checkpoint，Core 工业 Action 仍未实现；Chip Pack MCP 已经共享 Gateway 接入                                                                                                 |
| Skill 和 Domain MCP 均采用渐进式披露                   | Broker 已披露 Skill 和 Tool Scope；Kimi 外部工具按 Scope 注册。Chip Pack 服务已通过当前 Scope Gateway 接入                                                                                                                                                         |
| 产品支持多个工业场景，首批以 Chip 和 PCB 验证          | 有 Chip/PCB 首批 Capability 声明；PCB 真实工具尚未接入                                                                                                                                                                                                             |
| 建立独立 Viewer 层                                     | KLayout、netlistsvg、Surfer 三组 Viewer 位于正式产品路径并已接入桌面 MVP                                                                                                                                                                                           |
| 通用聊天与文件工作区                                   | 输入区不固定 Chip/PCB 阶段；Broker 根据任务识别上下文，右侧默认预览普通文件，专用格式启用 Viewer                                                                                                                                                                   |
| 桌面 UI 与 Headless CLI 分离                           | `apps/desktop` 与 `apps/cli` 是两个入口；共用 Broker、Project Domain 约束、Capability Registry 和 Kimi Integration；CLI 不依赖 Electron 或 Viewer UI，供 Domain Task bench 调用                                                                                    |
| 默认 Skill/MCP 由仓库声明，Project 可禁用              | 四个检查 Skill 与 Chip Pack 操作 Skill 已作为仓库文件接入；Project 只存禁用 ID，Broker 与 Kimi 会话使用有效配置。Domain MCP 注册与会话配置入口已建立，当前默认注册 Chip Pack 0.6.0                                                                                 |
| Computer Use 以横切插件接入，不进入 Domain 体系        | `packages/computer-use-bridge` 已实现：二进制钉定 release 并校验 SHA-256，18 个 GUI 工具经 Kimi 会话 externalTools 声明式注册，启用即授权（自动 session 审批），桌面与 CLI 共享同一桥接包；GUI 调用尚未进入 Domain Runtime Action/Verification（已登记 prototype） |

## ADR-001：CLI 作为独立评测入口

- 日期：2026-09-23
- 状态：方向已确定；首版接口已实现，真实模型 bench 仍待验证
- 原因：Domain Task bench 需要自动运行任务、收集事件与结果，不应依赖桌面渲染和人工操作。
- 决定：UI 与 CLI 分属独立应用，任务 Scope 与 Agent 接入复用无界面包。CLI 每次绑定一个项目目录与 Domain，提供机器可读事件输出；模型密钥仅从环境读取。桌面专属的 IPC、窗口和 Viewer 代码不得进入 CLI 依赖图。
- 当前边界：Scope 解析、跨领域拒绝和 JSON Lines 输出已通过无 Electron 测试。桌面主进程仍持有部分项目/会话编排，后续继续下沉；真实模型执行、审批与超时路径需在 bench 中验证。

## ADR-002：仓库默认资源与 Project 覆盖

- 日期：2026-09-23
- 状态：Skill 路径已实现；MCP 注册入口已实现，Chip Pack 已通过共用 Gateway 与两个入口验证
- 决定：Skill 文件留在 `packages/domain-skills/skills/`，MCP 提供者声明留在 `packages/domain-mcp`。Project 持久化禁用 ID，CLI 使用对应参数。Broker 先按 Project 策略过滤 Skill/Tool，再解析 Scope；Kimi 会话的 `extra_skill_dirs` 只追加当前 Scope 的仓库 Skill，保留 Kimi 原有的项目/用户 Skill 搜索路径。独立会话目录中的 `mcp.json` 只写入已选中的服务器，不修改用户的 Kimi 全局配置。
- 执行边界：MCP 声明必须绑定 Domain 和完整 canonical Tool ID 集合；普通直连服务器只有在其全部声明工具都处于当前 Scope 且未禁用时才能进入会话；受控 Gateway 可只开放 Scope 内的子集。现有 Harness 外部工具仍在处理器再次校验 Scope。对于 MCP 服务实际暴露工具超出声明的情况，直连无法提供执行级 allowlist；接入首个默认服务器前必须验证其固定工具面，或经由受控 Gateway 代理。

## ADR-003：Industrial Core Vertical Slice 作为当前里程碑

- 日期：2026-09-23
- 状态：方向已确定；Vertical Slice 尚未实现
- 决定：以 Project → StateProvider → DomainState → Broker → Kimi → scoped Tool → Domain Runtime → Action → Artifact → Verifier → new DomainState → Checkpoint 的真实链路作为晋级 Gate。最小持久化位于首条 E2E 之前；失败 Action 可有空产物集合，但必须保留诊断与未通过的验证状态。只有真实集成测试通过后才称为 Industrial Harness Core v0.1。
- 约束：现有 MVP 硬编码和内存状态列入 `prototype-register.json`，架构 CI 冻结其扩展。新的具体领域 Tool、Viewer 或执行路径不能继续添加到这些上层捷径中。详细 DoD 见 `04-definition-of-done-and-architecture-tests.md`。

## ADR-004：27B 上下文锚点与诊断日志

- 日期：2026-09-25
- 状态：只读观察链已实现；完整工业状态仍待 ADR-003 的 Vertical Slice
- 决定：保持 Kimi Code 的 Agent Loop、会话与压缩实现。Harness 控制自身外部工具的输出大小，以有效 Scope 判定会话复用，每轮注入受限的文件观察 Checkpoint 锚点，并提供按页取回工具。SQLite 只保存已登记文件的路径、内容哈希和 `not_run` 验证状态；不从模型对话中生成工程事实。
- 诊断：每轮落盘完整 SDK 可见事件和 Broker Trace，保留未截断工具结果，标记已知凭据字段，目录与文件权限分别为 `0700`、`0600`。日志与观察状态不替代 Run、Action、Verifier 或工程 Checkpoint。
- 验证：真实 Qwen 27B 服务完成外部工具调用和自动压缩后 Checkpoint 再读取。长上下文检索在约 8k、64k、229k、244k、249k、255k 实际输入 token 下进行；细节见 [评测记录](27b-evaluation-results.md)。

## ADR-005：Computer Use 横切插件

- 日期：2026-09-28
- 状态：插件已实现并接入桌面与 CLI；GUI 调用的 Domain Runtime Action/Verification 缺口已登记 `prototype-register.json`（`computer-use-plugin`）
- 2026-10-12 修订：插件声明 `protectedSafe`（宿主侧执行、启用即授权、调用全量记诊断日志），受保护工业会话经 `execution-policy` 放行该插件；未声明 `protectedSafe` 的插件仍被剥离并以 `resources-filtered` 结构化事件呈现。原生沙箱会话路径（`createSession`）同步解除对应用控制插件的硬拒绝，外部 MCP 服务的隔离规则不变。
- 原因：用户需要在 Harness 中驱动桌面 GUI（含 CAD 应用）。GUI 能力不属于任何工业 Domain，不应进入 Domain Pack、Domain MCP 注册表或 Broker Capability 解析；同时不应修改 Kimi 核心。
- 决定：
  1. 新增 `packages/computer-use-bridge` 承载全部 computer-use 集成（安装器、MCP stdio 客户端、工具面、Skill 文本）。桌面与 CLI 共享该包，不重复实现。
  2. GUI 工具通过 Kimi 会话的 `externalTools` 声明式注册，canonical ID 前缀 `computer-use.`，工具面冻结为 18 个（不含 `browser_*` 浏览器驱动工具）；handler 保留在 Harness 手里作为执行边界，运行时校验启用状态并记录 diagnostic log。
  3. 二进制钉定上游 release（`munimtechnologies/munim-computer-use` v0.4.3），安装时校验 `SHA256SUMS.txt`；支持 `GUI_BRIDGE_SOURCE_REPO` / `GUI_BRIDGE_TAG` / `GUI_BRIDGE_RELEASE_BASE` / `GUI_BRIDGE_BIN` 环境变量覆盖，便于 fork 发布。
  4. MCP server 进程懒启动：首次工具调用才 spawn，`COMPUTER_USE_BROWSER=0` 启动使 server 实际暴露的工具面与声明一致；进程生命周期内复用。
  5. 审批语义为"启用即授权"：插件开启后，其工具的审批请求由 `KimiSession` 按 sender（工具名）自动 `approve_for_session`，不反复上抛 UI；非插件工具的审批行为不变。macOS 的截屏/辅助功能系统权限仍由操作系统在首次真实调用时提示。
- 已知缺口：GUI 调用尚未进入 Domain Runtime Action 记录与 VerificationResult，当前仅写 diagnostic log；browser 工具未暴露。
- 已知缺口（2026-09-29 code review 补充）：
  - 上游 Kimi CLI（1.51.0 实测）偶发在 `ToolCallRequest` 里丢弃流式到达的工具参数（发 `{}`），外部工具会收到空参。这发生在执行路径（CLI → SDK → handler），与 Harness 事件流的参数拼接修复（`0baa1b6` 只修复 UI 显示）无关；当前实际缓解是 `ARG_HINTS` 引导模型带全参重试。根因在上游，需跟踪 CLI 版本。
  - MCP server 进程崩溃后旧实现会复用死 client（每次调用吃满超时）；已改为死亡标记 + 重建。
  - 插件工具曾绕过 `createExternalTool`，参数 JSON Schema 与 zod 校验都不生效（模型只能靠 Skill 文本猜参数、脏类型直通 server）；已在会话组装处统一包装。
- 约束：`computer-use-bridge` 是第一个横切插件，其"不进 Domain 体系 + externalTools 注入"模式若扩展到第二个插件前，需要重新评审是否需要更正式的插件契约。

## 两份提案的差异及当前取舍

- **Agent 适配**：Broker Plan 描述可替换的通用 `AgentRuntimeAdapter`；架构 Plan 明确第一阶段专精 Kimi。当前选择 Kimi 专属 Integration，不以假定通用性压缩 Kimi 原生能力。工业契约保持独立，为未来新接入留出边界。
- **Broker 与控制面**：Broker Plan 建议独立本地 Sidecar；架构 Plan 描述包含 Broker 职责的 Harness Daemon。先分清逻辑职责，进程部署形态由跨平台生命周期与故障隔离测试决定。
- **MCP Gateway 时序**：架构 Plan 建议统一 Gateway；Broker Plan 允许 V1 先直连现有 MCP，后续整合。首版必须验证受控 Tool Scope 和渐进式披露；是否先用直连方式由 SDK 能力与集成复杂度决定。
- **发布包**：两份材料都设想随桌面应用安装 Kimi 和 Broker。当前源码随依赖携带 MIT 许可的 Kimi Code 2.1.1（ADR-007）。旧 Python 1.52.0 仅显示迁移提示。历史 Release 不自动更新；三平台安装与原生组件仍需独立验收。

## 待验证问题

1. 新 Kimi Code `2.1.1` 的长上下文压缩和真实工业工作负载是否达到旧 27B 基线？
2. 能否在不修改 Kimi 核心的情况下按会话更新 Skill Batch 与 MCP Tool Scope？生效时点与撤销语义是什么？
3. 本地控制面、Broker、Gateway 与 Kimi 分进程或同进程时，哪种形态更可靠且便于三平台打包？
4. Domain Pack 的 schema、安装格式、资源校验和版本兼容边界如何冻结？
5. 芯片与 PCB 的首批真实动作分别由哪个工具和验证器承担？
6. 各领域哪些格式适合内置渲染？首批解析器的许可证、性能和跨平台限制是什么？

上述问题应先通过探针、契约测试和真实流程记录结论，再将提案升级为正式 ADR。

## ADR-005：复用 Chip Pack Runtime 的共享 MCP Gateway

- 日期：2026-09-29
- 状态：Desktop/CLI 注册与真实 MCP 路径已落实；Core Vertical Slice 仍待实现
- 决定：复用 EDA Harness 0.6.0 已有 Runtime，通过 canonical ToolDescriptor、项目绑定 Gateway、按需 schema 和执行时 allowlist 接入。两个入口共用声明、资源策略和 Kimi 会话配置。
- 验证：固定 Kimi CLI 和真实 stdio MCP，经受控模型响应完成审批、目标持久化与 EDA 上下文回读；越权、跨项目、参数、禁用与大结果分页均有检查。macOS 桌面实测；工业计算与其他平台未在本次验收。详见 [MCP 接入](domain-mcp-integration.md)。

## ADR-006：显式注册外部 host MCP，经共享 Gateway 进入 Scope

- 日期：2026-09-29
- 状态：已实现；具体供应商服务及 OS 权限需独立验证
- 决定：遵照用户要求，在 Domain MCP 下层增加用户注册表与独立 Gateway。外部服务不伪装为 Domain Pack/Capability；Broker 在有效策略后加入 canonical 工具，固定入口提供渐进披露，执行时重查参数、Scope 和完整快照。Desktop/CLI 共用私有注册，项目不提供启动命令。
- 边界：host 工具可跨项目控制应用，roots 只是上下文；所有实际调用沿用 Kimi mutating 审批，返回保持 not_run，不写工程状态。工业 Action 仍走 Domain Runtime。保持固定 Kimi Agent Loop，不添加另一 Agent 或供应商 computer-use 客户端。
- 验证：真实 stdio/HTTP/SSE、固定 Kimi 审批/图片输入及 macOS UI 注册/禁用/刷新/移除。受控模型/服务仅证明协议链路，详见 [外部 MCP](external-mcp.md)。

## ADR-007：迁移至开源 Kimi Code 2.1.1 的公开 Server API

- 日期：2026-10-05
- 状态：共享接入已实现；验收与限制见 [迁移记录](kimi-code-migration.md)
- 原因：旧 CLI 已归档，旧 npm SDK 的 Wire 启动参数不能用于新 CLI；新 Node SDK 尚未公开发布至 npm。
- 决定：精确依赖 `@moonshot-ai/kimi-code@2.1.1` 与 lockfile，复用 `kimi web` REST/WebSocket API。每个受资源管理的会话有独立 home、进程和随机认证 token。关闭自动更新并核对服务版本。
- 工具：现有宿主工具和插件回调作为认证本地 MCP 提供，保留 Domain Gateway 与执行时 Scope 校验；发送 Prompt 前等待已配置 MCP 连接完成。上游继续拥有 Agent Loop、原生工具和持久化，无 fork 或复制的 SDK。
- 恢复：只保存原生身份映射。兼容键加入内核与版本，旧历史保留并开启新上下文段，不导入或改写旧上下文。停止、崩溃和事件断连不自动重提动作。
- 诊断：消息 API 快照明确标成“已保存对话”，不冒充完整模型上下文或 HTTP 请求；保留旧日志只读解析。
- 上游 API 为实验性，后续升级须通过固定版本契约和真实运输测试。

## ADR-008：核心 PR 检查与完整验收分层

- 日期：2026-10-14
- 状态：按产品 owner 在 PR #151 工作会话中“让 CI 缩一缩，只保留一些核心的”的明确要求实施；本修订单独提交，验证记录见 PR。
- 原因：近期完整运行约消耗 86–92 runner 分钟，其中 macOS 占约 81–83%；双版本工业矩阵、全新软件安装和重复桌面场景主导等待时间。基础跨平台测试本身仅需数分钟，并曾检出 Linux 专属账号存储 fixture 缺陷，不能因为仅修改 Desktop 就省略。
- 决定：普通代码 PR 与默认手动运行保留仓库/协议、四平台 Portable、macOS/Windows 打包启动与基础 UI、真实 Linux Kimi/RTL/隔离/恢复和打包 Headless 路径。账号登录工作流保持原有触发。纯文档 PR 保留仓库层及独立架构检查。
- 完整验收：main 推送及手动 full=true 保留原有 macOS 15/26 工业与安装矩阵、完整 Desktop Domain/CAD 安装，以及 Linux 旧版升级、干净安装与 Docker 执行。原生用例、严格测试计数及失败断言不删减；复用 Desktop/Linux 工作流的其他调用默认仍完整执行。
- 边界：本决定调整既有 CI/native 验收的执行频率，取代“每个代码 PR 全部执行”的调度要求；Architecture contract workflow、checker、policy、例外基线和分支保护保持不变。核心检查通过不表示本次提交已完成 macOS 原生工业或完整安装验收；涉及这些路径的变更可在合并前手动运行完整验收。
- 迁移：入口统一输出 core/full 计划，下游显式接收；All checks passed 仅接受计划内省略，拒绝必需层缺席、意外跳过、取消或失败。文件列表失败阻止通过，达到 API 上限则完整执行；未知事件也完整执行。
- 正反验证：执行实际工作流中的分类脚本，覆盖文档/运行时 Skill/仅 Desktop/重命名/分页/手动布尔输入/文件列表异常；逐层验证缺失、失败、取消、意外跳过不能通过。另验证完整矩阵与原生测试目录保持完整、复用工作流默认 full，以及架构契约与现有架构测试。
