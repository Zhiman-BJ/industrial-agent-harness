# Industrial Capability Broker

Capability Broker 是工业能力的本地调度层。它根据当前 Domain State 与用户任务，选择相关 Capability，并形成 Skill Batch、MCP Tool Scope、查看与验证需求。设计目标是让领域能力按需出现，同时留下可审计的披露和执行轨迹。

## 核心概念

| 概念              | 含义                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| Domain            | 工业领域，例如 chip 或 pcb                                                       |
| Domain State      | 项目当前阶段、产物、问题和指标的结构化描述                                       |
| Capability        | 可执行的工业意图及其适用条件                                                     |
| Capability Bundle | 一个 Capability 对应的 skills、canonical tools、viewer、verification、依赖与冲突 |
| Skill Batch       | 当前任务需要的一组知识与流程说明                                                 |
| Tool Scope        | 当前会话允许发现和调用的一组工具                                                 |
| Session Scope     | 某会话当前激活的能力、skills 和 tools                                            |
| Disclosure Trace  | 候选、筛选、披露、调用与范围变化的记录                                           |

例如芯片 placement 拥塞优化可以把密度调优、拥塞诊断、时序分析的 skills 与相关 OpenROAD 工具组合成一个 Bundle。PCB DRC 修复则应得到另一组能力，而不会看到芯片物理设计工具。

## 渐进式披露

```text
L0 领域索引 → L1 能力索引 → L2 Skill Batch 与 Tool Scope
                                      ↓
                         L3 详细 Skill Reference 与 Tool Schema
```

初始入口只需支持项目检查、状态查询与能力搜索。Broker 在任务与状态明确后展开对应的 skills 和工具范围；大型参考内容与完整参数 schema 再按需读取。披露范围是会话的当前状态，不随对话持续累积。领域或阶段变化时，重新解析并替换旧 Scope。

V1 的 Resolver 建议使用确定性流程：领域和阶段硬过滤，产物条件检查，任务意图匹配与优先级排序，最后处理依赖、冲突与去重。意图匹配不能越过领域和权限约束。V1 不依赖额外 LLM 进行路由。

### 已实现：能力详情查询的拒绝与恢复

Agent adapter 动态注册 `industrial_capability_detail`，内部 MCP 审批名带 `mcp__harness_adapter__` 前缀；它不是领域原生 Tool，也不属于领域工具目录。参数 `capabilityId` 必须来自执行时的 `scope.capabilityIds`，人工批准该调用不会扩大 Scope。

越界查询保留工具错误状态，返回有界 JSON：`code: CAPABILITY_OUT_OF_SCOPE`、`message`、`requestedCapabilityId`、`allowedCapabilityIds`、`scopeVersion` 和 `nextStep`。错误只披露当前允许的能力 ID，不读取被拒能力的详情、不进行别名猜测或自动授权；允许列表为空时停止详情查询，等待宿主重新解析 Scope。Kimi 原生工具循环可以根据错误返回的有效 ID 纠正调用。

`industrial_state_inspect` 重新检查状态并解析 Scope 后，返回 `state`、`allowedTools`、`capabilityIds` 和 `scopeVersion`。能力 ID 与 Tool ID 分开，版本用于关联本次观察；它们不替代实际执行时的 Scope 和 expected State 检查。工具事件按调用 ID 保留完整参数或旧分片参数，避免交错调用时空事件覆盖已有参数，支持诊断无效能力 ID。

## 声明与工具身份

Capability 声明建议采用 YAML，字段至少覆盖稳定 ID、版本、领域、适用状态、skills、canonical tool IDs、验证要求、依赖、冲突和优先级。示意：

```yaml
id: chip.pd.placement.optimize
version: 1
domain: chip
match:
  stages: [placement]
  artifacts: [odb, def]
skills: [chip-pd-placement, chip-pd-congestion-debug]
tools: [openroad.get_congestion, openroad.global_placement]
verification: [timing, congestion]
requires: [common.checkpoint]
```

这是提案示例，尚未冻结为机器校验的 schema。`openroad.global_placement` 是 Harness 的 canonical ID；具体 MCP server 和 tool 名称由工具注册表映射。Capability 文件不直接依赖某个服务实例的内部命名。

## Scope 与执行

多个 Capability 可以合并，但要展开依赖、检测冲突、稳定去重并保留来源。Tool Scope 必须在实际调用边界实施 allowlist；只在提示词中列出允许工具不足以形成执行约束。对会修改项目的工具，还需要项目绑定和权限判定。

Broker 可以先作为独立本地 Sidecar 实现，再与控制面和 MCP Gateway 协同部署。计划材料分别提出 REST/WebSocket、Kimi 本地 API、直接连接现有 MCP 以及统一 Gateway；这些是待验证的集成方案，不是已经确定的 SDK 能力。当前接口已迁至固定 Kimi Code 2.1.1 的公开 Server API，见 [迁移记录](kimi-code-migration.md)；跨平台打包仍需独立验收。

## Trace 与评估

桌面 MVP 已实现确定性关键词匹配的首批 Chip/PCB Capability Registry，并记录 L0 领域索引、L1 候选和匹配、L2 Scope/Skill/Tool 披露、L3 延迟详情加载。Debug 模式展示这些真实决策事件。当前工具 Scope 作用于交给 Kimi SDK 的 Harness 外部工具，工具处理器在调用时再核验 Scope；Chip Pack MCP 已通过执行边界校验的 Gateway 接入；Kimi 内建工具的统一工业执行策略仍需后续验证。

默认 Skill 已由仓库中的 `SKILL.md` 文件注册，Project 保存禁用 ID。Broker 在解析前过滤被禁用的资源，并记录 `resource.policy` Trace；Kimi 会话通过 `extra_skill_dirs` 只追加当前 Scope 的仓库 Skill。Domain MCP 已注册 Chip Pack，默认清单和 ToolDescriptors 经校验合入共享 Registry；Gateway 检查真实工具面，只按需披露选中工具 schema，调用时校验 Scope 和项目。见 [MCP 接入](domain-mcp-integration.md)。

每个 Project 绑定一个本地目录和一个 Domain。创建 Project 时从 Capability Registry 注册的领域中选择，之后在该 Project 的详情页修改。新 Session 在输入框中用只读小按钮展示所属 Domain；主进程拒绝跨领域解析请求。修改项目 Domain 时清空当前会话 Scope，Broker 结果中的阶段选项也受项目 Domain 限制。当前 MVP 在确定的领域内，根据任务词与用户指向的选中产物格式识别能力及阶段，并在 Trace 中记录 `context.infer`。没有匹配能力时区分两种情况：从任务文本推断领域（未显式绑定 Domain）时保留空工业 Tool Scope，Kimi 仍可处理普通项目任务；显式绑定 Domain 的会话（桌面 Project 或 CLI 发行版均属此类）回退选中该域优先级最高的 Capability，避免口语化任务措辞绕开类型化工具、改走通用底座的高开销路径，回退以 `domain-bound fallback` 记入 L1 Trace。更完整的项目 Domain State 尚未实现，当前推断不作为工程状态事实。

每次解析至少记录任务、Domain State、候选和选中的 Capability、披露的 Skill/Tool、Scope 版本与决策原因。工具调用后关联实际调用、结果、Action、Artifact 和 Verification。Trace 不应把未验证的工具返回包装为成功结论。

评估同时比较完整暴露与渐进式披露：任务成功率、工具选择准确率、无效调用、输入 token、Agent 步数、延迟和上下文大小。减少 token 只是其中一个指标；降低跨领域误选同样重要。

当 StateProvider 的 stage 为 null 时，只能选择明确声明 `stages: []` 的阶段无关能力，用于空工程初始化或检查。Broker 保留真实 stage=null，并继续绑定 Project/State ID；关键词不能使其他阶段工具越权可用。FreeCAD 首批建模按此注册，几何事实仍来自 Runtime 和回读证据。
