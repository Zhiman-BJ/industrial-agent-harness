# 统一配对评测基线

新增 `scripts/benchmark-paired.cjs` 用于在相同输入、Task、模型配置与实际 wall-time 预算下，顺序运行原生 Kimi 和生产 Harness 两个驱动。本基线设置独立工程验收，不使用模型回答中的 PASS 作为结果。

## 无凭据工程 smoke

```sh
node scripts/benchmark-paired.cjs --suite examples/bench/paired-chip-counter/smoke.json --output-dir /tmp/industrial-paired-results
node --test tests/benchmark/*.test.cjs
```

结果目录必须不存在，防止覆盖历史证据。本机需 `iverilog` 和 `vvp`，缺少时 runner 明确失败；相关工程测试明确 skip，不生成成功率。示例有一处 enable 门控错误，两个标签都使用同一个确定性修复 fixture，再用外置 testbench 检查 reset、disabled hold、increment、wrap 和 reset priority。原项目保持不变。

这只验收 runner、输入隔离与真实编译/仿真链路，两标签不是两种模型。`mode=engineering-smoke` 的 `firstAttemptSuccessRate`、token usage、cost 均为 `null`，`rankingEligible=false`。2026-10-04 在 macOS 的真实 Icarus 环境完成两次工程验收；不把这个结果计入模型评测。

## 冻结内容

Suite 使用 `schemaVersion:1`，包括：

| 内容 | 冻结与执行约束 |
| --- | --- |
| Task | `id/domain/prompt/projectDir/inputTreeSha256`；每次计算 Task 文本身份与输入树身份 |
| 输入 | 只允许普通文件/目录，拒绝 symlink；每支、每 seed 单独拷贝工作目录；执行前重新检查原输入身份 |
| 模型 | `provider/id/configurationId`，两驱动运行时回报的身份必须一致 |
| 驱动/Verifier | 固定命令参数、可执行文件 SHA-256 与实现文件 SHA-256；不经过 Shell，执行后复查身份 |
| 工具/环境 | `platform/toolchainId/tools`，记录实际 OS、架构、Node、工具路径及身份；工具执行前后复查 |
| 预算 | 相同 `budget.maxMs`；超时先中断、再回收进程组；Verifier 使用单独固定预算 |
| 次序/种子 | `seeds` 唯一非负整数，奇偶轮换先运行的驱动；当前驱动无模型随机种子控制，驱动明确报告 `seedControl:not-enforced` |
| 证据 | 各支 stdout/stderr 轨迹、轨迹 SHA、产物树 SHA、Verifier 输出、逐任务记录与汇总 |

可计算输入身份：`node scripts/benchmark-paired.cjs --hash-input /absolute/project`。修改 fixture、driver 或 testbench 后必须重新生成冻结值；不得沿用旧身份。

stdout/stderr 在写盘前对环境中的已知凭据值做流式脱敏，保留足够后缀处理跨字节块情况。轨迹身份对应脱敏后的文件。Suite 不得携带 Key/Token/Secret/Password 环境值，实际凭据由启动环境提供。

## 原生 Kimi 与 Harness 驱动

现有可运行的正式驱动：

```sh
node scripts/benchmark-native-kimi.cjs PROJECT TASK_FILE OUTPUT_DIR PROFILE_FILE
node scripts/benchmark-harness.cjs PROJECT DOMAIN TASK_FILE OUTPUT_DIR PROFILE_FILE
```

原生驱动使用 `agent-kimi` 已声明的精确 Kimi SDK 版本直接建立原生会话，不注入 Harness 工业上下文或工具。Harness 驱动直接调用共享 TaskService、Broker 与 Runtime，仅用于开发评测，不交付 CLI 或 SDK 产品。两者加载同一份模型配置，并沿用相同的单次输出 cap、context size、thinking 和批准策略。两者的聊天/资源配置都放在本次隔离结果目录中，首次运行不加载用户历史。

共同 profile 是 JSON，包含 `configurationId/provider/endpoint/model/contextSize/thinking/imageInput/apiKeyEnv/kimiExecutable`。API Key 从 `apiKeyEnv` 指定的环境变量读取，不能写入文件；`kimiExecutable` 相对 profile 所在目录解析。正式 Suite 应冻结 profile、驱动、辅助文件、Runtime/Pack 版本、锁文件、Kimi/Python/验证工具身份。

把 smoke Suite 改为 `mode:paired-model` 后，必须补齐 `model` 和冻结环境；两支 command 分别调用上述驱动。参数占位符支持 `{projectDir}`、`{domain}`、`{taskFile}`、`{outputDir}`、`{suiteDir}`、`{seed}`、`{maxMs}`。命令的 `sha256` 是可执行文件身份，`files:[{path,sha256}]` 是实现与配置文件身份。正式 mode 要求两个驱动和独立 Verifier 都有冻结文件身份，工具也有身份；预检失败时不会生成正式结果。

专业 Chip Runtime 仍仅开放已声明的 RTL lint/仿真；现有共享 Runtime 已提供受审批的源码修改与声明任务执行。但本例 counter repair 的冻结任务、独立 Verifier 和原生执行策略尚未补齐，不能因此作为已验收的正式 benchmark。可用的声明式工程任务参考 `tests/integration/fixtures/industrial-rtl/eda.yaml`；首轮正式对照需要为其编写并冻结独立 Verifier、任务集和原生执行策略。不得让 Harness 的驱动直接写源码来填补生产 Runtime 缺口。

## 汇总解释

`passed` 同时要求驱动正常退出、未超预算、工具/模型/实现身份有效，并且独立 Verifier 成功。即使模型答 PASS 或 Agent turn finished，Verifier 失败仍计失败。

`first-attempt` 从全新输入与会话开始，每任务每 seed 只运行一次。`diagnostic` 必须记录父 `summary.json` 的 SHA-256，单独输出；诊断续跑不进入首次成功率。产出逐对结果、接受数、耗时和可测用量。当前 runner 只强制 wall-time，`maxTokens` 必须为 `null`，`tokenBudgetEnforced=false`；默认驱动尚未聚合可核对的总 token/cost，因此写 `null`，不会推算价格。

模型或工具身份异常时，`comparisonValid=false`，两支首次成功率都为 `null`，不能把无效环境混进结果。身份完整的正式首轮才生成成功率；`rankingEligible` 始终为 false，因为统计规模、Verifier 抗投机和正式审查属于另一步评测验收。

`tests/benchmark/model-drivers.test.cjs` 在已安装 Kimi 时用本地受控提供方真实跑两支入口并核对模型/Task，未使用付费模型；响应不执行工程任务。现阶段没有原生 Kimi 与 Harness 的真实付费工程成功率、成本优势或排行数据。
