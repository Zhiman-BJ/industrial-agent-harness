# Industrial Capability Broker

Capability Broker 是工业能力的本地调度层。它根据当前 Domain State 与用户任务，选择相关 Capability，并形成 Skill Batch、MCP Tool Scope、查看与验证需求。设计目标是让领域能力按需出现，同时留下可审计的披露和执行轨迹。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| Domain | 工业领域，例如 chip 或 pcb |
| Domain State | 项目当前阶段、产物、问题和指标的结构化描述 |
| Capability | 可执行的工业意图及其适用条件 |
| Capability Bundle | 一个 Capability 对应的 skills、canonical tools、viewer、verification、依赖与冲突 |
| Skill Batch | 当前任务需要的一组知识与流程说明 |
| Tool Scope | 当前会话允许发现和调用的一组工具 |
| Session Scope | 某会话当前激活的能力、skills 和 tools |
| Disclosure Trace | 候选、筛选、披露、调用与范围变化的记录 |

例如芯片 placement 拥塞优化可以把密度调优、拥塞诊断、时序分析的 skills 与相关 OpenROAD 工具组合成一个 Bundle。PCB DRC 修复则应得到另一组能力，而不会看到芯片物理设计工具。

## 渐进式披露

```text
L0 领域索引 → L1 能力索引 → L2 Skill Batch 与 Tool Scope
                                      ↓
                         L3 详细 Skill Reference 与 Tool Schema
```

初始入口只需支持项目检查、状态查询与能力搜索。Broker 在任务与状态明确后展开对应的 skills 和工具范围；大型参考内容与完整参数 schema 再按需读取。披露范围是会话的当前状态，不随对话持续累积。领域或阶段变化时，重新解析并替换旧 Scope。

V1 的 Resolver 建议使用确定性流程：领域和阶段硬过滤，产物条件检查，任务意图匹配与优先级排序，最后处理依赖、冲突与去重。意图匹配不能越过领域和权限约束。V1 不依赖额外 LLM 进行路由。

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

Broker 可以先作为独立本地 Sidecar 实现，再与控制面和 MCP Gateway 协同部署。计划材料分别提出 REST/WebSocket、Kimi 本地 API、直接连接现有 MCP 以及统一 Gateway；这些是待验证的集成方案，不是已经确定的 SDK 能力。最终接口以 `@moonshot-ai/kimi-agent-sdk@0.1.8` 的实测结果和跨平台打包验证为准。

## Trace 与评估

桌面 MVP 已实现确定性关键词匹配的首批 Chip/PCB Capability Registry，并记录 L0 领域索引、L1 候选和匹配、L2 Scope/Skill/Tool 披露、L3 延迟详情加载。Debug 模式展示这些真实决策事件。当前工具 Scope 作用于交给 Kimi SDK 的 Harness 外部工具，工具处理器在调用时再核验 Scope；Domain MCP Gateway 和 Kimi 内建工具的统一执行策略仍需后续验证。

每次解析至少记录任务、Domain State、候选和选中的 Capability、披露的 Skill/Tool、Scope 版本与决策原因。工具调用后关联实际调用、结果、Action、Artifact 和 Verification。Trace 不应把未验证的工具返回包装为成功结论。

评估同时比较完整暴露与渐进式披露：任务成功率、工具选择准确率、无效调用、输入 token、Agent 步数、延迟和上下文大小。减少 token 只是其中一个指标；降低跨领域误选同样重要。
