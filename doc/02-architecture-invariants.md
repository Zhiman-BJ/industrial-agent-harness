# Industrial Agent Harness：架构不变量

> 状态：当前里程碑约束。`AGENTS.md` 保存摘要，本页保留理由、现有 Prototype 和替换目标。来源为用户提供的同名评审材料，已按仓库现状修订。

## 1. 为什么现有 AGENTS.md 仍不足以阻止架构跑偏

当前 `AGENTS.md` 的大方向其实是正确的：

- 工业 State / Artifact / Action / Verification / Checkpoint 归 Harness；
- Domain-specific behavior 属于 Domain Pack；
- Capability 应从 Domain State + Task 解析；
- Tool Scope 应在 execution boundary 强制执行；
- Viewer 不能充当 Verification；
- 不重复实现 Kimi Agent Loop / Compaction / Session / Tool Loop。

问题不是“没有说明正确架构”，而是：

> 当前规则主要是 Architecture Principles，而不是不可绕过的 Architecture Invariants。

Agent 在面对缺失底层抽象时，会倾向于使用最快能跑通 Demo 的 shortcut：

```text
缺 DomainState → 用 prompt keyword 推断
缺 Tool Registry → 写 object map
缺 Artifact Registry → new Map()
缺 Runtime → 在 Electron/MCP 里直接执行
缺 Viewer Registry → if/else 按 artifact kind 分发
```

每一个 shortcut 单独看都合理，但叠加后会形成架构债。

---

# 2. Non-negotiable Architecture Invariants

建议在 `AGENTS.md` 顶部新增下面的硬约束。

## Invariant 1：Domain State 是工程事实唯一来源

- Prompt 只表示用户意图。
- Prompt 不得直接创建未经核验的工程事实；用户给出的约束可记录为带来源的输入。
- 如果某个事实可以从 Domain State / Artifact / Verification 得到，就不得通过关键词猜测替代。

```text
Intent ≠ Engineering Fact
```

---

## Invariant 2：所有工业 Action 必须经过 Domain Runtime

禁止：

```text
Electron → OpenROAD
CLI → Yosys
MCP → KiCad
```

必须：

```text
Electron / CLI / MCP
        ↓
   Domain Runtime
        ↓
 Industrial Tool
```

---

## Invariant 3：所有 Mutating Action 都必须有 Run / Artifact / Verification

执行成功不等于工程成功。

任何修改工程状态的 Action 必须：

1. 创建 Run / Action identity；
2. 记录真实输入；
3. 记录显式 Artifact 集合；执行失败时集合可以为空；
4. 产生 VerificationResult，未运行或证据不足也要明确记录；
5. 只有 Verification 才能建立新的工程事实。

---

## Invariant 4：Process success 不能成为工程验收结论

禁止：

```text
exitCode == 0
→ state.status = passed
```

必须：

```text
ProcessResult
→ Verifier
→ VerificationResult
→ State transition
```

---

## Invariant 5：Artifact Contract 必须统一

所有工业 Artifact 使用共享 `ArtifactRef` / Registry。

Desktop、Viewer、CLI 可以有 presentation view model，但不能拥有另一套“事实 Artifact”。

---

## Invariant 6：Core 中禁止具体 Domain 泄漏

以下包中禁止硬编码具体 Domain / Capability / Canonical Industrial Tool ID：

```text
harness-core
capability-broker
agent-kimi
viewer-core
contracts
```

例如这些都不应出现在 `agent-kimi`：

```text
chip.*
pcb.*
openroad.*
eda.netlist.inspect
```

它们必须通过 Descriptor / Registry 动态注入。

---

## Invariant 7：Agent Integration 只消费 ToolDescriptor

Kimi Integration 不理解任何具体领域。

```text
Domain Pack
→ Tool Registry
→ ToolDescriptor
→ agent-kimi
→ createExternalTool()
```

---

## Invariant 8：Tool Scope 必须在执行边界再次强制检查

Progressive Disclosure 只是上下文管理，不是权限系统。

必须同时存在：

```text
Disclosure Scope
+
Execution Allowlist
```

Agent 即使知道某个隐藏 Tool ID，也无法越 Scope 调用。

当前 Harness 外部 Tool 在处理器中再次校验 Scope；Domain MCP 目前没有真实服务器。接入前必须在 Gateway/Runtime 对实际调用再次检查，不能仅依赖配置文件或向模型展示的工具列表。

---

## Invariant 9：Viewer 选择必须经过 Viewer Core / Registry

禁止 Electron 直接：

```text
if layout → LayoutViewport
if netlist → NetlistViewport
```

必须：

```text
ArtifactRef
→ Viewer Registry
→ ViewerDescriptor
→ Viewer implementation
```

---

## Invariant 10：缺少下层抽象时先实现下层，不允许把 shortcut 固化为正式架构

这是最重要的一条。

如果当前任务依赖的 lower-layer abstraction 不存在：

> 实现该 abstraction，而不是在 upper layer 中模拟它。

例如：

```text
缺 Domain State
→ 实现 State Provider

而不是
→ 在 Broker 里继续增加关键词推断
```

---

# 3. Current Milestone Gate

当前仓库应进入：

> Industrial Core Vertical Slice 阶段

在下面这条链路通过真实 integration test 之前：

```text
Project
→ StateProvider
→ DomainState
→ Capability Broker
→ Kimi
→ Tool Scope
→ Domain Runtime
→ real industrial Action
→ Artifact
→ Verifier
→ new DomainState
→ Checkpoint
```

## 暂停新增

除 vertical slice 必需内容外，不再优先开发：

- 新 Desktop UX；
- 新 Viewer；
- 新 Capability Demo；
- 新 Domain；
- `agent-kimi` 中新的 hardcoded external tools；
- trajectory replay UI；
- 多 Agent 通用 Adapter。

---

# 4. Prototype Escape Hatches

MVP shortcut 可以存在，但必须明确标记为 prototype，并且有替换目标。

建议登记当前 prototype：

| Prototype | 当前用途 | 正式替换目标 |
|---|---|---|
| Desktop in-memory artifact map | Viewer MVP | Persistent Artifact Registry |
| CLI in-memory artifact manifest map | Bench MVP | Shared Artifact Registry |
| Keyword context inference | Broker Demo | DomainState-driven Resolver |
| `agent-kimi` canonical tool map | External Tool Demo | Tool Registry |
| Electron concrete Viewer dispatch | Viewer MVP | Viewer Core/Registry |
| Electron Viewer Host concrete dispatch | Viewer MVP | Viewer Core/Registry |
| Static `capabilities.cjs` | Domain Demo | Domain Pack Loader |

以上是**已有代码的限界例外**，不是新实现的许可。可机读登记见 [`prototype-register.json`](prototype-register.json)；架构测试锁定现有硬编码与分发范围，新增同类分支应失败。迁移完成后删除对应例外。

Prototype 规则：

- 不能成为 Core 的依赖；
- 不能定义跨模块正式 contract；
- 不允许继续扩展新领域能力；
- 替换目标完成后应删除旧路径。

---

# 5. AGENTS.md 应该保持短而硬

不建议继续把所有设计细节塞入 AGENTS.md。

推荐结构：

```text
AGENTS.md
├─ Architectural Invariants
├─ Current Milestone Gate
├─ Definition of Done summary
└─ Links to detailed docs
```

详细说明继续放：

```text
doc/
├─ architecture.md
├─ domain-state.md
├─ runtime.md
├─ capability-broker.md
├─ domain-pack.md
└─ verification.md
```

这样 Agent 每次都能先读到最重要的“不允许违反什么”，而不是被大量实现细节淹没。
