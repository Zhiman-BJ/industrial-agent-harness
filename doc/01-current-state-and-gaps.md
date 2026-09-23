# Industrial Agent Harness：当前现状、问题与解决方案

> 状态：2026-09-23 的仓库评审基线。本页描述现状与目标，不把目标接口视为已实现。来源为用户提供的同名评审材料，已按仓库代码核对。

## 1. 当前项目定位

当前项目已经不再是空 scaffold，而是一个可运行的 **Kimi-based Industrial Agent Workbench MVP**。

目前已经比较完整的部分：

- Electron Desktop Workbench
- Headless CLI
- Kimi Agent SDK 接入
- Project 与 Domain 绑定
- Capability Broker 雏形
- 仓库 Skill 与 Harness 外部 Tool 的初步渐进式披露（尚无真实 Domain MCP 服务）
- EDA Viewer：GDS/OAS、Yosys JSON、VCD/FST/GHW
- 基本 CI、单元测试与 Desktop self-test

但真正定义 Industrial Harness 的内核还没有形成：

- Domain State
- Industrial Runtime
- Domain MCP Gateway
- Run / Action / Artifact / Verification 生命周期
- Persistent Artifact Registry
- Checkpoint / 供 Bench 使用的执行轨迹（MVP 不包含轨迹重放 UI）
- 可安装的 Domain Pack
- 真正的工业 Tool E2E

因此当前结构更接近：

```text
Project
  ↓
Task
  ↓
Capability Resolver
  ↓
Skill + read-only inspect tool
  ↓
Kimi
  ↓
Project files / Viewer
```

目标结构应当变成：

```text
Project
  ↓
Domain State
  ↓
Capability Broker
  ↓
Kimi
  ↓
Scoped Tool
  ↓
Domain Runtime
  ↓
Action
  ↓
Artifact
  ↓
Verifier
  ↓
New Domain State
  ↓
Checkpoint / Trajectory
```

---

# 2. contracts：工业数据模型目前没有统一

## 问题

当前 Broker、CLI、Desktop、Viewer 都有自己的数据结构。

例如 Artifact 在不同层有不同定义。未来 Runtime 又会新增 Run、Action、Verification、Checkpoint。

如果继续这样发展，很容易出现：

```text
Desktop Artifact
       ≠
Runtime Artifact
       ≠
Viewer Artifact
       ≠
Bench Artifact
```

这会导致大量 adapter、重复字段和来源不一致。

## 解决方案

把 `packages/contracts` 建成整个 Harness 的唯一工业协议层。

至少统一：

```text
ProjectRef
DomainState
Run
ActionRequest
ActionResult
ArtifactRef
ArtifactManifest
VerificationRequest
VerificationResult
CapabilityDescriptor
ToolDescriptor
SkillDescriptor
CheckpointRef
HarnessEvent
```

建议采用：

```text
TypeScript type
+
Zod schema
+
schemaVersion
```

所有跨模块工业对象只能来自 `@industrial-agent-harness/contracts`。

## 完成标准

- Broker、Runtime、Viewer、CLI 不再定义自己的 Artifact 主模型。
- 所有外部输入经过 runtime validation。
- schema 有明确版本。

---

# 3. Domain State：Broker 目前仍主要依赖 Prompt 推断

## 问题

当前 Capability Resolver 的主要信息来源是：

```text
Task text
+ Domain
+ Stage
+ artifactKind
```

其中 stage/context 很多时候来自 keyword 与 artifact 推断。

这只能用于 MVP，不足以支撑真实工业任务。

例如用户说“优化 timing”，系统必须知道：

- 当前处于 synthesis / placement / CTS / routing 哪个阶段；
- 是否有 ODB / DEF / SDC；
- 最新 WNS / TNS；
- 哪一次 STA 是当前可信结果；
- 当前 DRC / LVS 状态；
- 哪个 checkpoint 是当前 design state。

这些都不能从 prompt 推断。

## 解决方案

每个 Domain Pack 提供 `StateProvider`：

```ts
interface StateProvider {
  inspect(project: ProjectRef): Promise<DomainState>
}
```

例如 Chip State：

```yaml
domain: chip
stage:
  logical: rtl
  physical: placement
artifacts:
  rtl: art-001
  netlist: art-011
  odb: art-021
verification:
  simulation: pass
  formal: unknown
metrics:
  timing:
    wns: -0.18
    tns: -6.4
```

Broker API 从：

```text
resolve(task, domain, stage)
```

升级为：

```text
resolve(task, DomainState)
```

Prompt 表达“用户意图”，DomainState 提供“工程事实”。

## 完成标准

- 工程 stage 不再由 UI 或 prompt 直接声明为事实。
- Broker 的硬过滤来自 DomainState。
- State Provider 读取真实项目产物和验证结果。

---

# 4. Run / Action / Artifact / Verification：当前 Tool Call 没有工业生命周期

## 问题

当前 Tool Call 主要是：

```text
Agent
→ ToolCall
→ ToolResult
```

这不足以回答：

- 输入是什么；
- 使用什么工具版本；
- 参数是什么；
- 生成什么产物；
- 产物 hash 是什么；
- 是否完成工程验收；
- 这次执行是否改变 design state。

此外“进程成功”与“工程目标完成”被混在一起会非常危险。

## 解决方案

所有工业操作统一形成：

```text
Run
 └─ Action
     ├─ Inputs
     ├─ Execution
     ├─ Output Artifacts
     └─ VerificationResult
```

Verification 状态至少应支持：

```text
passed
failed
insufficient_evidence
not_run
```

例如：

```json
{
  "verifier": "chip.sta",
  "status": "failed",
  "metrics": {"wns": -0.18},
  "evidence": ["artifact://sta-report-12"]
}
```

## 完成标准

- `exitCode=0` 不得直接写入 DomainState 为“通过”。
- Mutating Action 必须关联 Run/Action、显式产物集合与 VerificationResult；执行在产物生成前失败时，产物集合可以为空，验证状态必须明确为 `not_run` 或 `insufficient_evidence`。
- UI 区分“Action completed”和“Verification passed”。

---

# 5. domain-runtime：执行链目前没有统一核心

## 问题

Desktop 主进程现在同时承担：

```text
Project
Artifact
Broker
Kimi
Viewer
部分执行编排
```

如果以后 OpenROAD、KiCad、Godot 分别被 Electron、CLI、MCP 直接调用，会形成多套执行语义。

## 解决方案

所有工业操作统一进入：

```ts
runtime.execute(ActionRequest)
```

Runtime 负责：

```text
权限检查
→ Tool 解析
→ 创建 Run / Action
→ 工作目录准备
→ 执行
→ stdout/stderr 捕获
→ Artifact 收集
→ Verifier
→ State transition
→ Evidence / Trace 持久化
```

Electron、CLI、MCP 都只作为 adapter。

Runtime 必须 deterministic first：它负责可靠执行，不负责决定下一步策略。

## 完成标准

- CLI / Desktop / MCP 不直接执行工业工具。
- 三个入口调用同一个 Runtime。
- 同一 Action 在不同入口下产生一致结构化结果。

---

# 6. Tool Registry：agent-kimi 仍存在领域硬编码

## 问题

`agent-kimi` 中存在具体 canonical tool mapping，例如 EDA/PCB Tool ID。

这意味着增加 Godot/CAD/CAE 时还需要修改 Kimi integration。

## 解决方案

建立 Tool Registry，由 Domain Pack 提供 `ToolDescriptor`：

```yaml
id: openroad.global_placement
version: 1
domain: chip
risk: mutating
inputSchema: ...
outputArtifacts: [odb]
runtime:
  executor: openroad
verification:
  - timing
  - congestion
```

Kimi Integration 只负责：

```text
ToolDescriptor
→ createExternalTool()
```

不理解具体 domain/tool 名称。

## 完成标准

- `agent-kimi` 中没有 `chip`、`pcb`、`openroad.*` 等具体工业 ID。
- Tool Descriptor 可动态生成 Agent tool。

---

# 7. domain-mcp：Progressive Disclosure 目前还不是执行边界

## 问题

目前 Tool Scope 主要限制 Harness external tools。

未来 MCP 工具数量增加后，不能只靠“不给模型展示”来当安全约束。

## 解决方案

建立统一 Industrial MCP Gateway：

```text
Kimi
 ↓
Industrial MCP Gateway
 ├─ capability.search
 ├─ capability.detail
 ├─ tool.describe
 └─ tool.call
       ↓
   Domain Runtime
```

Broker 为 session 生成真实 allowlist：

```json
{
  "allowedTools": [
    "openroad.get_timing",
    "openroad.global_placement"
  ]
}
```

执行时 Gateway/Runtime 再次校验，不允许越 Scope 调用。

## 完成标准

- Tool disclosure 与 Tool execution permission 分离。
- Out-of-scope 调用在执行边界被拒绝。

---

# 8. Domain Pack：目前还是 source code，不是插件

## 问题

当前 Chip/PCB Capability 直接写在主仓库 `domain-skills` 中。

因此增加领域仍需修改 Core repo。

## 解决方案

实现真正的 Domain Pack：

```text
domain-packs/<domain>/
├── domain.yaml
├── capabilities/
├── skills/
├── tools/
├── state/
├── verifiers/
├── viewers/
└── bridges/
```

Pack Loader 负责：

- 发现；
- schema 校验；
- 版本与依赖；
- health check；
- enable / disable；
- 加载失败隔离。

## 完成标准

新增 Godot Domain 时，不修改 `harness-core`、`agent-kimi`、`capability-broker`。

---

# 9. Chip E2E：当前缺少真实工业 Vertical Slice

## 问题

当前已经能展示 GDS/VCD/Netlist，也能让 Kimi 获取 metadata，但还没有证明真实工业闭环。

## 解决方案

第一条 E2E 不要直接做 OpenROAD 全流程，先做 RTL verification：

```text
User task
→ DomainState
→ chip.rtl.simulate
→ Skill
→ verilator.run
→ Runtime
→ simulation.log + waveform.vcd
→ Verifier
→ simulation pass/fail
→ New DomainState
→ Viewer 打开 VCD
```

然后再逐步扩展：

```text
Verilator
→ Yosys
→ OpenROAD
```

## 完成标准

- 使用真实工具；
- 生成真实 Artifact；
- 真实 Verifier 改变 State；
- CLI 与 Desktop 均能运行该链路。

---

# 10. PCB Pack：验证 Core 抽象不是 Chip-specific

## 问题

只做 Chip 时很容易把 Chip 的流程误当成通用工业抽象。

## 解决方案

第二个领域选择 KiCad，并要求完全复用同一套：

```text
State
Action
Artifact
Verification
Checkpoint
```

建议第一条流程：

```text
.kicad_pcb
→ DomainState
→ pcb.drc.check
→ kicad.drc.run
→ drc-report
→ Verification
→ New State
```

## 完成标准

- PCB 不需要修改 Core 数据模型的芯片特例。
- Chip/PCB 均通过同一 Runtime 与 Contract 运行。

---

# 11. Persistent State / Checkpoint：当前无法支持历史、Bench 与 Trajectory

## 问题

目前很多状态存在内存 Map / Electron process 中。

重启后丢失，也不能可靠比较分支、恢复状态或生成 trajectory。

## 解决方案

第一版采用最简单组合：

```text
SQLite
+
Content-addressed Artifact Store
```

SQLite 保存：

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

大文件按 SHA256 存储：

```text
~/.industrial-harness/store/sha256/...
```

Checkpoint 保存 State 与 Artifact 集合，并支持 parent：

```text
cp-10
├─ cp-11 timing strategy
└─ cp-12 power strategy
```

自然形成 Design State DAG。

## 完成标准

- 重启后 Run/Action/Artifact/Verification 可查询。
- Checkpoint 可恢复与比较。
- Bench 可引用具体 run/checkpoint。

---

# 12. 跨平台打包：源码能跑不等于产品可安装

## 问题

当前运行依赖 Node、pnpm、Electron、Kimi CLI、Python/KLayout，未来还会有 Yosys、Verilator、OpenROAD、KiCad 等。

如果依赖用户自己配置，本质仍是开发环境。

## 解决方案

拆成：

```text
Core Runtime
+
Domain Bundle
```

Core Runtime 自带 Harness、Kimi runtime、Broker、Runtime、MCP Gateway、SQLite。

Domain Bundle 独立显示资源占用，例如：

```text
Chip Design    8.4 GB
PCB Design     2.1 GB
Godot Game     1.8 GB
```

首版优先 bundled binaries / runtime environment，避免 Docker 成为桌面产品的前置依赖。

---

# 总结

当前项目最需要的不是继续扩 UI，而是把：

```text
Domain State
→ Action
→ Artifact
→ Verification
→ New State
```

真正建起来。

这五个对象和它们的 Runtime 关系，是 Industrial Harness 与普通 Coding Agent Workbench 的根本区别。
