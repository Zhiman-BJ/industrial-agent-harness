# Harness core

Shared project-domain Broker resolution and resource enablement policy for Desktop and CLI. Global defaults and project overrides store only stable resource IDs; an absent project override inherits the global default. Scope and capability detail use the same effective disabled lists before Kimi materializes Skills or selects scoped MCP providers.

`ResourceSettings` reads and atomically writes `~/.industrial-agent-harness/resource-settings.json` (0600), or the directory supplied by `INDUSTRIAL_HARNESS_CONFIG_DIR`. Projects are keyed by their canonical filesystem directory. Legacy desktop disabled IDs migrate once to explicit project overrides. Corrupt settings fail explicitly rather than silently replacing policy. This package does not implement an agent loop, industrial execution, or MCP Gateway.

`ChatStore` 保存产品聊天、每轮展示事件和不透明的 Agent 运行时关联，提供 Project/Domain 隔离、分页、跨进程执行锁和中断标记。它不依赖 Kimi/Electron，也不保存或压缩模型上下文；Desktop/CLI 共用该存储。见 [聊天持久化](../../doc/chat-persistence.md)。
