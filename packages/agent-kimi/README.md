# Kimi agent adapter

Thin integration around `@moonshot-ai/kimi-agent-sdk`, pinned to `0.1.8` in this package and the root lockfile. It will map sessions, events, tool registration, approvals, interruption, and recovery where supported by the SDK. Validate the actual API before claiming a capability.

当前已接入会话启动、流式文本、工具事件、审批与中断入口。有效 Broker Scope（domain、stage、capability、skill、tool）或模型配置变化时创建新会话；仅 Scope 版本号变化会复用原会话。只注册当前 Scope 对应的 Harness 外部工具，工具处理器再次校验当前 Scope。需要本机 Kimi CLI 才能做真实会话验证。

Harness 外部工具返回最多 16 KiB UTF-8 JSON；能力详情可按 `skills`、`tools`、`verification` 分段获取。每轮 Industrial Context 最多 8 KiB。SDK 的上下文占用和压缩事件会汇总为 `context-metrics`；界面工具结果截断会标注原始字节数。这些边界不作用于 Kimi 原生工具或 MCP 工具，也不改写 Kimi 的上下文压缩。

每轮生成一份完整的 JSONL 诊断日志，保留 Broker Trace、实际送入 SDK 的提示、SDK 暴露的原始事件和未截断的工具结果。固定 CLI 版本的 `context.jsonl` 与 `wire.jsonl` 也在每轮结束时保存受限权限的快照，日志记录路径、字节数及 SHA-256；快照失败会显式记录。日志路径通过 `diagnostic-log` 事件给 CLI 与桌面 Debug 模式。已知 API Key 和常见凭据字段会脱敏；日志仍含工程数据。若提供观察状态回调，提示中会附带最小 Checkpoint 锚点，`industrial_context_read` 可按页取回；该工具只报告文件哈希观察，不报告工程验收结论。

每个 SDK 会话使用独立 Kimi share directory（Desktop/CLI 提供持久目录，未提供持久回调的调用方使用临时目录）：复制模型配置，以 `extra_skill_dirs` 添加经过 Project 禁用策略和 Broker Scope 筛选的仓库 Skill，并生成会话 `mcp.json`。Kimi 原有的项目/用户 Skill 搜索路径仍可使用。关闭会话只删除临时目录，持久目录仅在明确删除聊天时清理；用户的 `~/.kimi` 不会被改写。当前默认 MCP 列表为空。

`DiagnosticReader` 提供当前项目的运行列表、原始记录分页及 UTF-8 分段读取；只读语义投影提供时间线、上下文和调用/返回配对，不改写原始日志。上下文从同项目同 Trace 的固定原生快照读取，验证路径、大小及 SHA-256；无压缩且当前提示及全部 Checkpoint 保留时，按步骤边界展示保存的消息。该视图不是完整 HTTP 请求记录，不猜测缺失的上下文或工具定义。索引缓存有界，完整语义内容只缓存一轮；原始记录最多 64 MiB，单记录 16 MiB，上下文快照最多 64 MiB；逐步骤消息关联最多 200,000 项。SDK/UI 双重记录只在展示中去重。支持范围与 UI 限额见 [桌面文档](../../apps/desktop/README.md)。

`KimiSession.run(task, images)` 接受经校验的内联 PNG/JPEG/WebP 用户参考。有图时调用原生 SDK `prompt(ContentPart[])`，保留原始 data URL；无图保持字符串接口。模型能力配置共享于 CLI/Desktop，声明支持图片时生成 `image_in`；配置不支持则在请求前拒绝，不静默退化成文本。图片字节、尺寸、哈希及实际 ContentPart 存入每轮诊断日志；这些输入不构成工程验证结果。

`KIMI_EXECUTABLE=/absolute/path/to/kimi node --test packages/agent-kimi/tests/vision-wire.test.cjs` 从仓库根目录执行真实 SDK 0.1.8 / CLI 1.51.0 的可选集成测试。它使用本地 OpenAI SSE fixture，检查实际 Provider 请求中的图片与原生历史，不使用真实 API key。CI 未安装 CLI 时明确跳过；普通测试仍检查生产 adapter 的多模态发送、能力拒绝及完整日志。桌面三种图片格式与当前 MiniMax M3 实际识图已在 macOS 验证。

Desktop/CLI 通过 `resolveSession` / `sessionInitialized` 回调提供共享聊天索引中的不透明运行时身份。有效 Scope 与模型配置兼容时，把原 session ID 和持久 share directory 交给 SDK 恢复；不兼容时产生新段。已初始化的上下文丢失会报错，不默默创建空上下文。接口与验证见 [聊天持久化](../../doc/chat-persistence.md)。

## 横切插件注入

`KimiSession` 构造参数 `plugins` 接收横切插件对象（如 `computer-use-bridge` 的 `createGuiPlugin`），每项形如 `{name, enabled(), toolNames, materializeSkill(dir), toolsFactory()}`。启用的插件会把 skill 目录并入会话 `extra_skill_dirs`，并把其外部工具与 Broker 工具一起注册；本包不依赖任何具体插件，也不感知其领域属性。启用即授权：插件工具触发的 `ApprovalRequest`（按 `sender` 工具名匹配）由本包自动以 `approve_for_session` 应答，不上抛 UI；非插件工具的审批卡片保持不变。插件工具自身的执行边界校验（如会话内被禁用即拒绝）由各插件在自己的 handler 内完成。