# 开发计划

当前已完成仓库骨架、模块说明和 `@moonshot-ai/kimi-agent-sdk@0.1.8` 依赖固定。以下阶段将两份计划材料整理为可验证的实施顺序。它们是开发计划，不表示功能已经交付。

## 阶段与验收

| 阶段 | 主要产出 | 可检查的完成条件 |
| --- | --- | --- |
| M0 契约与 SDK 探针 | Domain State、Artifact、Action、Verification Result、Capability、Tool/Skill Descriptor 的最小 schema；Kimi SDK 接口探针 | schema 可校验；固定 SDK 能力与缺口有实测记录；确定最小会话链路 |
| M1 Broker Registry | Domain、Capability、Skill、Tool 注册与配置校验 | Chip/PCB 声明能加载、查询、重载；坏 Pack 被隔离并给出诊断 |
| M2 Resolver 与 Scope | 状态过滤、意图匹配、依赖/冲突处理、Skill Batch、Tool Scope | 同一输入得到稳定结果；跨领域工具不进入 Scope；阶段切换替换旧 Scope |
| M3 Kimi 集成 | 会话、事件、权限、Context 与 Tool Scope 接入 | 真实 Kimi 会话只获得当前能力；拒绝、取消、断开和恢复路径可观察 |
| M4 工业运行与 MCP | Action、Artifact、Verification 的最小闭环；统一工具入口 | 一个真实工业动作有来源、结果与验证；禁止工具在执行边界被拒绝 |
| M5 Chip 与 PCB 参考链路 | 各一个真实项目流，基本查看器与领域验证 | 两个领域都经同一 Broker 与核心契约运行，产物可在桌面端追溯 |
| M6 Checkpoint、Trace 与打包 | 状态保存、披露/执行轨迹、桌面发行物 | 重启后可查看历史；发布包在 Linux、macOS、Windows 分别验证启动和核心链路 |

M0 应优先核实 SDK `0.1.8` 与目标 Kimi 运行时的关系，包括会话创建和恢复、事件、动态 skills/MCP、工具范围、审批与中断。计划文档给出的 REST/WebSocket 路径只是候选实现，不作为 SDK 已支持的证据。

## 首批场景

1. **Chip placement**：在 placement 阶段处理拥塞问题。解析到 Chip 相关 Skill/Tool，读取真实拥塞及时序数据，执行允许的动作并保存验证结果；PCB 工具不得进入 Scope。
2. **PCB DRC**：在 PCB 布局阶段定位并修复规则问题。只披露相关 KiCad 能力；OpenROAD/Yosys 工具不得进入 Scope。
3. **阶段转换**：项目从 placement 进入 routing 或 CTS 后，旧 Skill Batch 和 Tool Scope 被替换，Trace 能说明前后变化。
4. **失败与缺证据**：缺工具、工具失败、缺少验证输入或产物不匹配时显示真实阻塞，不回退到演示数据。

计划材料为 V1 提出两个领域、六个 Capability、约十五个 Skill 和三十个 Tool。这些数字作为覆盖目标，只有接入真实工具并通过验收后才计入已交付能力。

## 验证策略

Registry、匹配、依赖、冲突、合并和阶段转换用确定性测试验证。Broker 与 Kimi 的交界先用假适配器验证契约，再用固定版本 SDK 和受控 MCP 做真实集成测试。桌面端需要覆盖项目切换、权限、断连、产物查看与应用重启。发行物按目标操作系统分别验证，不用单一平台构建结果推断其他平台可用。

渐进式披露应与完整暴露基线比较，记录任务成功率、误选工具、无效调用、输入 token、步数、延迟及上下文规模；评估数据必须指向具体任务、Scope 和运行证据。

## 暂缓范围

跨 Agent 通用适配、LLM 路由、自动训练、远程多机基础设施、GUI Pack 市场和完整 RL 平台均不在首批交付中。Gateway 可以分阶段落地，但 Skill 与 Tool 的渐进式披露必须在首个真实 Kimi 链路中得到验证。
