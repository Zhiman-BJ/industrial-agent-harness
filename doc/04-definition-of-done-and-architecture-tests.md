# Industrial Agent Harness：Definition of Done 与架构测试

> 状态：下一阶段完成标准及当前 CI 门禁。来源为用户提供的同名评审材料；已区分当前可自动检查的边界与待 Vertical Slice 实现后才能启用的 Gate。

## 1. 为什么需要 DoD

当前 repo 中已经出现“目录/README 已存在，但实现仍是 placeholder”的情况。

如果没有统一 Definition of Done，Agent 很容易把：

```text
interface 已定义
README 已写
package 已创建
```

理解为：

```text
feature implemented
```

这会造成架构文档与真实执行路径长期不一致。

---

# 2. Definition of Done

一个架构模块只有满足以下条件，才能在文档中标记为 `implemented`：

1. **Production code exists**
   不只是 interface / README / stub。

2. **At least one real consumer uses it**
   上游模块真正通过它运行。

3. **At least one integration test exercises the real path**
   不能只有 isolated unit test。

4. **Old bypass path has been removed or explicitly marked prototype**
   不允许“新 Core 存在，但 Desktop 继续绕过它”。

5. **Failure path is tested**
   包括 invalid input、timeout、tool failure、missing artifact、out-of-scope 等。

6. **Docs reflect the exercised behavior**
   文档不能把 proposal 写成事实。

对于失败在执行前或产物生成前的修改型 Action，仍须保存 Run/Action、失败诊断、显式空产物集合，以及 `not_run` 或 `insufficient_evidence` 的 VerificationResult；不能为了满足 DoD 伪造产物。

---

# 3. 各核心模块的 DoD

## Contracts

完成条件：

- Zod + TS schema；
- schema version；
- Broker / Runtime / CLI 至少三方使用；
- invalid payload 有测试。

---

## DomainState

完成条件：

- 真实 StateProvider；
- 读取真实工程事实；
- Broker 直接消费；
- Prompt 不再替代可获得的状态事实。

---

## Domain Runtime

完成条件：

- Desktop/CLI/MCP 至少两个入口走同一 runtime；
- 一个真实 Tool 执行；
- Run/Action/Artifact/Verification 都落地；
- timeout / process failure 有测试。

---

## Viewer Core

完成条件：

- Desktop 不再直接根据 kind import/dispatch concrete viewer；
- 所有 Viewer 通过 Registry discovery；
- unsupported/missing companion/resource limit 有真实测试。

---

## Domain Pack

完成条件：

- Pack Loader 能动态发现；
- manifest 校验；
- malformed Pack 不影响其他 Domain；
- 添加一个 test domain 不修改 core source。

---

## Domain MCP

完成条件：

- MCP server 实际存在；
- 披露结果根据 Scope 改变。若采用固定 `tool.call` 方法，MCP 方法列表可以不变，但 `capability.search` / `tool.describe` 的内容必须受 Scope 限制；
- out-of-scope tool call 被 server/runtime 拒绝；
- desktop/cli 不依赖 MCP 才能使用 Runtime。

---

# 4. Architecture Tests

Markdown 规则必须尽量变成 CI 中的自动门禁。

已增加：

```text
tests/architecture/
```

当前 CI 执行静态依赖边界、已知 Prototype 范围冻结、工业可执行文件直接调用检查和里程碑声明检查。尚未实现的 Contracts、Runtime、Viewer Registry、Domain Pack 和 MCP 真实调用以 [`prototype-register.json`](prototype-register.json) 跟踪；对应集成测试仍是完成该模块的必需 Gate，不能由静态测试代替。

---

## Test A：Core 禁止依赖 Kimi

检查：

```text
packages/harness-core/**
packages/contracts/**
packages/domain-runtime/**
```

禁止 import：

```text
@moonshot-ai/kimi-agent-sdk
packages/agent-kimi
```

---

## Test B：Agent Adapter 禁止具体 Domain ID

扫描：

```text
packages/agent-kimi/**
```

禁止新增注册表中的具体 ID；现存 MVP 映射只在 Prototype Register 列出的精确范围内暂时允许：

```text
chip
pcb
openroad.*
kicad.*
eda.* canonical IDs
```

允许它消费 `ToolDescriptor`，但不允许维护具体 tool map。

---

## Test C：Broker 禁止 concrete runtime imports

`capability-broker` 只能做：

```text
state + task
→ capability / scope
```

不得 import：

```text
OpenROAD
Yosys
KiCad
Electron
Kimi SDK
```

---

## Test D：Desktop 禁止直接执行工业 Tool

扫描 Electron 主进程，禁止直接 spawn：

```text
yosys
verilator
openroad
kicad
```

这些 executable 只能由 Runtime executor 调用。

---

## Test E：Viewer 统一经过 Registry

禁止 Desktop 新增；当前三种已存在的直接分发为冻结的 Prototype：

```text
if artifact.kind === "xxx" → concrete viewer
```

具体 viewer 只能在 Viewer Registry / Pack 注册。

---

## Test F：Mutating Tool 必须声明 Verification

Tool Descriptor 如果：

```yaml
risk: mutating
```

必须有：

```yaml
verification:
  - ...
```

否则 schema 校验失败。当前尚无正式 ToolDescriptor schema；CI 先检查现有声明中若出现 `risk: mutating` 必须带验证声明，正式 schema 建立时删除过渡检查。

---

## Test G：Tool Scope 在执行层验证

集成测试：

```text
Broker scope: [tool-A]
Agent/runtime call: tool-B
```

必须失败，无论 tool-B 是否能被底层 provider 实际执行。

---

# 5. Milestone Gate Test

Core 阶段必须新增一个最高价值 E2E：

```text
industrial-core-vertical-slice.test
```

测试真实流程：

```text
fixture project
→ StateProvider
→ DomainState
→ Broker
→ Scoped Tool
→ Runtime
→ Verilator
→ Artifact
→ Verifier
→ New State
→ Checkpoint
```

只有这个测试通过，才能把仓库阶段从：

```text
Workbench MVP
```

更新为：

```text
Industrial Harness Core v0.1
```

---

# 6. CI 阶段目标

当前 CI 已执行架构边界、构建和现有单元测试。首条 Vertical Slice 测试文件加入后，CI 将自动运行它；文件目前不存在，不能因此宣称 Core 已完成。Desktop self-test 已在本地运行，但尚未作为跨平台 CI Gate。Core Vertical Slice 阶段的目标 CI 至少分成四层：

```text
1. schema / architecture tests
2. unit tests
3. integration tests
4. vertical slice E2E
```

平台打包阶段再增加：

```text
5. macOS package smoke test
6. Windows package smoke test
7. Linux package smoke test
```

---

# 7. 最终原则

最重要的改变不是“给 Agent 写更多文字”，而是把：

```text
Architecture Principle
```

转成：

```text
Invariant
+
Milestone Gate
+
Definition of Done
+
Architecture Test
```

这样 Coding Agent 写出不符合架构的实现时，会在 CI 中直接失败，而不是依赖它是否完整理解文档。
