# Headless v0.1.0-preview.1

这是用于场景测试的无 UI 预览包。下载 `.tar.gz` 与同名 `.sha256` 文件后，按 [安装说明](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/main/apps/cli/README.md#github-release-%E5%AE%89%E8%A3%85) 校验、解压并运行。Scope 测试需要 Node.js 22+；Agent 运行还需要另行安装 Kimi CLI，并配置模型 API Key。

## 相比原生 Kimi Code 集成了什么

- **Project 与领域约束**：一次运行绑定一个工程目录和 Chip 或 PCB 领域；Broker 的候选能力受该领域约束。
- **Capability Broker**：按任务解析当前能力 Scope，输出候选、选择理由及 L0–L3 披露 Trace。当前解析仍主要依靠关键词，尚无可靠的 DomainState 输入。
- **领域 Skill**：内置芯片网表、波形、版图及 PCB 板图四份 Skill。只将当前 Scope 允许且未禁用的 Skill 放入隔离的 Kimi 会话目录。
- **受 Scope 约束的只读工具**：可按需披露能力详情，读取已登记工件的元数据；调用时再次检查 Broker allowlist，并复核工件内容哈希。读取结果不代表工程验证通过。
- **MCP 接入机制**：包含 Domain MCP 注册表、按 Scope 和禁用策略选择服务器、为 Kimi 会话生成隔离 `mcp.json` 的代码。当前注册表为空，**没有可调用的默认 Domain MCP 服务器**。
- **无 UI 场景入口**：`run` 输出 JSON Lines 事件；`bench` 顺序执行场景 Suite，保存逐场 JSONL 和断言汇总。已附当前 Scope 烟测及预期失败的 RTL 验证目标场景。

Agent 会话、模型调用及原生 Agent 工具循环仍由 Kimi Code 负责；本包通过 Kimi Agent SDK 接入，没有重新实现这些能力。

## 尚未集成

- 包内没有 Kimi CLI 可执行文件、模型密钥或工业软件；真实 Agent 会话未作为此 Release 的端到端验收。
- 没有默认 Domain MCP provider，也没有真实工业 Tool 的 MCP Gateway。
- DomainState、工业 Action Runtime、Artifact/Verification 持久化与 Checkpoint 闭环尚未落地。RTL 验证请求目前不能选中 `chip.rtl.simulate`。
- 发布流水线在 Linux 解压并完成 Scope 场景烟测；这不构成工业执行或其他平台的支持声明。

完整芯片 MCP 另以 [Chip Pack v0.6.0-preview.1](https://github.com/Zhiman-BJ/industrial-agent-harness/releases/tag/chip-v0.6.0-preview.1) 独立发布。两包尚未通过 Core Broker Gateway 连接。
