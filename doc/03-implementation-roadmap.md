# Industrial Agent Harness：实施路线图

> 状态：下一阶段实施计划，不代表各项已交付。来源为用户提供的同名评审材料；已将最小持久化移到首条 Vertical Slice 之前，并区分最小 Checkpoint 与后续 DAG 能力。

## 总目标

下一阶段不再以“Workbench 功能更多”为目标，而以完成 **Industrial Harness Vertical Slice v0.1** 为目标。

最终验收链：

```text
Project
→ StateProvider
→ DomainState
→ Capability Broker
→ Kimi
→ Tool Scope
→ Domain Runtime
→ Industrial Action
→ Artifact
→ Verifier
→ New DomainState
→ Checkpoint
```

---

# P0：建立工业 Harness Core

## P0.1 Contracts

### 目标

建立跨模块唯一工业数据协议。

### 实施

新增：

```text
packages/contracts/
├─ project.ts
├─ state.ts
├─ run.ts
├─ action.ts
├─ artifact.ts
├─ verification.ts
├─ capability.ts
├─ tool.ts
├─ checkpoint.ts
└─ events.ts
```

所有对象提供 TypeScript type + Zod schema。

### 验收

- Broker/Runtime/CLI/Viewer 都消费统一 schema。
- CI 可以执行 schema validation test。

---

## P0.2 DomainState + StateProvider

### 目标

把 Broker 从 prompt-driven 变成 state-driven。

### 实施

定义：

```ts
interface StateProvider {
  inspect(project: ProjectRef): Promise<DomainState>
}
```

先实现 `chip` 最小 StateProvider：

- RTL 文件；
- testbench；
- simulation result；
- waveform；
- synthesis output；
- 基础 stage。

### 验收

- Broker 不再由 UI 传入工程 stage 作为事实。
- 同一 Project/Artifact 状态下，多次 inspect 得到稳定 DomainState。

---

## P0.3 Run / Action / Artifact / Verification

### 目标

建立真实工业生命周期。

### 实施

定义 Runtime 状态机：

```text
ActionRequested
→ ActionRunning
→ ActionCompleted / ActionFailed
→ ArtifactCollected
→ VerificationRunning
→ VerificationPassed / Failed / InsufficientEvidence
```

### 验收

一个真实 Tool invocation 可以完整查到：

```text
Run ID
Action ID
Inputs
Tool version
Parameters
stdout/stderr
Artifacts
VerificationResult
```

---

## P0.4 Domain Runtime

### 目标

成为所有工业 Tool 的唯一执行入口。

### 实施

建议 API：

```ts
runtime.execute(request: ActionRequest): Promise<ActionResult>
```

内部职责：

- policy；
- execution；
- artifact collection；
- verifier；
- state update；
- event emit。

### 验收

Desktop / CLI 不再直接调用具体工业 executable。

---

## P0.5 最小持久化与 Checkpoint

### 目标

首条真实 Vertical Slice 的 Run、Action、Artifact、Verification、DomainState 和 Checkpoint 在进程重启后仍可查询。

### 实施

使用 SQLite 保存身份、状态与关系；大产物按 SHA-256 存储。最小 Checkpoint 保存 State 和 Artifact 引用及 parent ID。先确保写入原子性、内容校验和重启恢复，再扩展分支比较与轨迹查询。

### 验收

- 运行后重启，CLI 与 Desktop 可查询相同 Run/Action/Verification；
- Checkpoint 引用的 Artifact 可按内容哈希重新读取；
- 失败 Action 保留诊断与显式空产物集合，不伪造工程通过。

---

# P1：Tool 与 Domain 插件化

## P1.1 Tool Registry

### 目标

消除 Agent Adapter 中的具体 domain/tool hardcode。

### 实施

提供：

```ts
registerTool(ToolDescriptor)
getTool(id)
listTools(scope)
```

### 验收

`agent-kimi` 不再维护 canonical tool ID mapping。

---

## P1.2 Domain MCP Gateway

### 目标

统一 Progressive Disclosure 与 Tool Execution boundary。

### 实施

最小 MCP surface：

```text
capability.search
capability.detail
tool.describe
tool.call
```

### 验收

- Agent 只能调用 Scope 内 Tool；
- 修改 prompt 无法绕过执行 allowlist。
- 若使用固定的 `tool.call` MCP surface，`capability.search`、`tool.describe` 的结果随 Scope 改变；不要求 MCP 方法名列表本身改变。

---

## P1.3 Domain Pack Loader

### 目标

把 Chip/PCB 从主 repo hardcode 转成可安装能力包。

### 实施

支持：

```text
domain.yaml
capabilities/
skills/
tools/
state/
verifiers/
viewers/
bridges/
```

### 验收

安装/卸载一个 Test Domain 不修改 Core repo。

---

## P1.4 Chip RTL Verification Vertical Slice

### 目标

第一条真正工业闭环。

### 建议场景

```text
User: Run RTL verification and find failing assertions.
```

流程：

```text
StateProvider
→ chip.rtl.simulate
→ Kimi
→ verilator.run
→ Runtime
→ simulation.log / waveform.vcd
→ assertion verifier
→ DomainState update
→ Viewer
→ Checkpoint
```

### 验收

- 真实 Verilator；
- 真实 testbench；
- 真实 VCD；
- 真实 verifier；
- Desktop/CLI 同路径。

---

# P2：跨领域验证与高级历史能力

## P2.1 PCB / KiCad Domain Pack

### 目标

验证 Core 不是为 Chip 特化。

### 首场景

```text
PCB DRC check
```

```text
.kicad_pcb
→ State
→ pcb.drc.check
→ KiCad
→ DRC artifact
→ Verification
→ New State
```

### 验收

不增加 Core 的 PCB-specific 分支。

---

## P2.2 Checkpoint DAG 与 Trajectory 查询

### 目标

在 P0.5 的最小持久化基础上支持分支、比较、Bench 引用与执行轨迹查询；不恢复 MVP 的轨迹重放 UI。

### 实施

扩展 P0.5 已建立的 SQLite metadata 与 Content-addressed Artifact Store，不另建一套 Registry。

### 目标数据表（基础表从 P0.5 延续）

```text
projects
runs
actions
artifacts
verification_results
states
checkpoints
trajectory_events
```

### 验收

- 重启恢复历史；
- Checkpoint parent chain 可查询；
- 两个 checkpoint 可比较 Artifact / metric；
- Bench 输出引用 run/checkpoint ID。

---

# P3：产品化安装

## P3.1 Runtime Bundle

Core installer 自带：

- Electron；
- Harness；
- Kimi runtime；
- Broker；
- Runtime；
- MCP Gateway；
- SQLite。

---

## P3.2 Domain Bundle

按领域独立安装：

```text
Chip Bundle
PCB Bundle
Godot Bundle
...
```

向用户展示：

- 下载大小；
- 安装后磁盘占用；
- 工具版本；
- 支持平台；
- Health status。

---

# 建议依赖顺序

```text
contracts
   ↓
DomainState
   ↓
Action / Artifact / Verification
   ↓
domain-runtime
   ↓
Minimal persistence / Checkpoint
   ↓
Tool Registry
   ↓
domain-mcp
   ↓
Chip Vertical Slice
   ↓
PCB Domain Pack
   ↓
Checkpoint DAG / Trajectory query
   ↓
Packaging
```

不要倒过来从 UI / Pack Marketplace / 大量 Capability 开始。

---

# 第一阶段唯一 KPI

不是 Viewer 数，不是 Capability 数，不是 Domain 数。

而是：

> **能否完成一条真实、可验证、可持久化、Desktop/CLI 共用的 State → Action → Verification 闭环。**
