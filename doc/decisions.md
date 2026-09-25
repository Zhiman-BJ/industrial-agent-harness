# 架构决策记录

本页区分当前已确定的方向、两份计划中的建议和仍需实测的接口。计划材料是设计输入，不是对现有实现的描述。

Project、Domain 和 Session 的用户交互决定见[产品决策记录](product-decisions.md)。

## 已确定

| 决定 | 当前落实情况 |
| --- | --- |
| Electron 桌面端面向 Linux、macOS、Windows | macOS 桌面 MVP 已运行；三平台打包尚未验证 |
| 第一阶段使用 Kimi Code，不自研 Coding Agent | `packages/agent-kimi` 精确依赖官方 SDK `0.1.8`；本地 CLI 固定 `1.51.0`，已使用真实 27B 模型验证文本、外部工具及自动压缩后取回 Checkpoint |
| Kimi 接入尽量非侵入 | 不把上游整仓作为 submodule；优先使用公开接口 |
| Monorepo 分离 UI、领域 Skill、领域 Runtime、MCP 等职责 | UI、Viewer、Broker、Kimi 和首批 Skill 声明已实现；Domain Runtime 只有只读观察状态与最小 Checkpoint，工业 Action/MCP 仍未实现 |
| Skill 和 Domain MCP 均采用渐进式披露 | Broker 已披露 Skill 和 Tool Scope；Kimi 外部工具按 Scope 注册。独立 Domain MCP 服务尚未接入 |
| 产品支持多个工业场景，首批以 Chip 和 PCB 验证 | 有 Chip/PCB 首批 Capability 声明；PCB 真实工具尚未接入 |
| 建立独立 Viewer 层 | KLayout、netlistsvg、Surfer 三组 Viewer 位于正式产品路径并已接入桌面 MVP |
| 通用聊天与文件工作区 | 输入区不固定 Chip/PCB 阶段；Broker 根据任务识别上下文，右侧默认预览普通文件，专用格式启用 Viewer |
| 桌面 UI 与 Headless CLI 分离 | `apps/desktop` 与 `apps/cli` 是两个入口；共用 Broker、Project Domain 约束、Capability Registry 和 Kimi Integration；CLI 不依赖 Electron 或 Viewer UI，供 Domain Task bench 调用 |
| 默认 Skill/MCP 由仓库声明，Project 可禁用 | 四个检查 Skill 已作为仓库文件接入；Project 只存禁用 ID，Broker 与 Kimi 会话使用有效配置。Domain MCP 注册与会话配置入口已建立，当前尚无可用的默认服务器 |

## ADR-001：CLI 作为独立评测入口

- 日期：2026-09-23
- 状态：方向已确定；首版接口已实现，真实模型 bench 仍待验证
- 原因：Domain Task bench 需要自动运行任务、收集事件与结果，不应依赖桌面渲染和人工操作。
- 决定：UI 与 CLI 分属独立应用，任务 Scope 与 Agent 接入复用无界面包。CLI 每次绑定一个项目目录与 Domain，提供机器可读事件输出；模型密钥仅从环境读取。桌面专属的 IPC、窗口和 Viewer 代码不得进入 CLI 依赖图。
- 当前边界：Scope 解析、跨领域拒绝和 JSON Lines 输出已通过无 Electron 测试。桌面主进程仍持有部分项目/会话编排，后续继续下沉；真实模型执行、审批与超时路径需在 bench 中验证。

## ADR-002：仓库默认资源与 Project 覆盖

- 日期：2026-09-23
- 状态：Skill 路径已实现；MCP 注册入口已实现，首个真实服务器待选定与验证
- 决定：Skill 文件留在 `packages/domain-skills/skills/`，MCP 提供者声明留在 `packages/domain-mcp`。Project 持久化禁用 ID，CLI 使用对应参数。Broker 先按 Project 策略过滤 Skill/Tool，再解析 Scope；Kimi 会话的 `extra_skill_dirs` 只追加当前 Scope 的仓库 Skill，保留 Kimi 原有的项目/用户 Skill 搜索路径。独立会话目录中的 `mcp.json` 只写入已选中的服务器，不修改用户的 Kimi 全局配置。
- 执行边界：MCP 声明必须绑定 Domain 和完整 canonical Tool ID 集合；一个服务器只有在其全部声明工具都处于当前 Scope 且未禁用时才能进入会话。现有 Harness 外部工具仍在处理器再次校验 Scope。对于 MCP 服务实际暴露工具超出声明的情况，直连无法提供执行级 allowlist；接入首个默认服务器前必须验证其固定工具面，或经由受控 Gateway 代理。

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

## 两份提案的差异及当前取舍

- **Agent 适配**：Broker Plan 描述可替换的通用 `AgentRuntimeAdapter`；架构 Plan 明确第一阶段专精 Kimi。当前选择 Kimi 专属 Integration，不以假定通用性压缩 Kimi 原生能力。工业契约保持独立，为未来新接入留出边界。
- **Broker 与控制面**：Broker Plan 建议独立本地 Sidecar；架构 Plan 描述包含 Broker 职责的 Harness Daemon。先分清逻辑职责，进程部署形态由跨平台生命周期与故障隔离测试决定。
- **MCP Gateway 时序**：架构 Plan 建议统一 Gateway；Broker Plan 允许 V1 先直连现有 MCP，后续整合。首版必须验证受控 Tool Scope 和渐进式披露；是否先用直连方式由 SDK 能力与集成复杂度决定。
- **发布包**：两份材料都设想随桌面应用安装 Kimi 和 Broker。开发环境使用本地 `kimi-cli==1.51.0`；桌面安装包如何携带 CLI、三平台校验和许可仍需单独决策。`1.52.0` 已将 Python CLI 入口替换为迁移提示，不能用于当前 SDK Wire 链路。

## 待验证问题

1. SDK `0.1.8` 与固定 CLI `1.51.0` 的审批、中断和恢复路径是否在真实任务中满足要求？
2. 能否在不修改 Kimi 核心的情况下按会话更新 Skill Batch 与 MCP Tool Scope？生效时点与撤销语义是什么？
3. 本地控制面、Broker、Gateway 与 Kimi 分进程或同进程时，哪种形态更可靠且便于三平台打包？
4. Domain Pack 的 schema、安装格式、资源校验和版本兼容边界如何冻结？
5. 芯片与 PCB 的首批真实动作分别由哪个工具和验证器承担？
6. 各领域哪些格式适合内置渲染？首批解析器的许可证、性能和跨平台限制是什么？

上述问题应先通过探针、契约测试和真实流程记录结论，再将提案升级为正式 ADR。
