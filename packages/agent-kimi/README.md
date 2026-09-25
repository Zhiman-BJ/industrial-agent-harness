# Kimi agent adapter

Thin integration around `@moonshot-ai/kimi-agent-sdk`, pinned to `0.1.8` in this package and the root lockfile. It will map sessions, events, tool registration, approvals, interruption, and recovery where supported by the SDK. Validate the actual API before claiming a capability.

当前已接入会话启动、流式文本、工具事件、审批与中断入口。有效 Broker Scope（domain、stage、capability、skill、tool）或模型配置变化时创建新会话；仅 Scope 版本号变化会复用原会话。只注册当前 Scope 对应的 Harness 外部工具，工具处理器再次校验当前 Scope。需要本机 Kimi CLI 才能做真实会话验证。

Harness 外部工具返回最多 16 KiB UTF-8 JSON；能力详情可按 `skills`、`tools`、`verification` 分段获取。每轮 Industrial Context 最多 8 KiB。SDK 的上下文占用和压缩事件会汇总为 `context-metrics`；界面工具结果截断会标注原始字节数。这些边界不作用于 Kimi 原生工具或 MCP 工具，也不改写 Kimi 的上下文压缩。

每个 SDK 会话还使用独立临时 Kimi share directory：复制模型配置，以 `extra_skill_dirs` 添加经过 Project 禁用策略和 Broker Scope 筛选的仓库 Skill，并生成会话 `mcp.json`。Kimi 原有的项目/用户 Skill 搜索路径仍可使用。关闭会话时删除这份临时配置；用户的 `~/.kimi` 不会被改写。当前默认 MCP 列表为空。
