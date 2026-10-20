# Harness core

Shared project-domain Broker resolution and resource enablement policy for Desktop and CLI. Global defaults and project overrides store only stable resource IDs; an absent project override inherits the global default. Scope and capability detail use the same effective disabled lists before Kimi materializes Skills or selects scoped MCP providers.

`createProjectRuntime({projectDir,domain,directory,environment,registry})` 从可信仓库/验签安装的 runtimePacks 加载领域入口，返回共享 Runtime、其 Capability 与需要保护的路径；每个领域和空工程都有共享 workspace Runtime，再组合匹配的领域插件；未建立事实阶段时 stage 保持 null。`resolveProjectTask` 接受规范 `request.state` 时使用 StateProvider 工程事实驱动 Broker，不由 Prompt 或 UI覆盖 stage。Core 只组织模块，不执行领域工具或实现 Agent loop。CLI 与 Desktop 项目缓存消费同一 Factory，实际闭环见 [P0 工业运行时](../../doc/p0-industrial-runtime.md)。

`ResourceSettings` reads and atomically writes `~/.industrial-agent-harness/resource-settings.json` (0600), or the directory supplied by `INDUSTRIAL_HARNESS_CONFIG_DIR`. Projects are keyed by their canonical filesystem directory. Legacy desktop disabled IDs migrate once to explicit project overrides. Corrupt settings fail explicitly rather than silently replacing policy. This package does not implement an agent loop, industrial execution, or MCP Gateway.

`ChatStore` 保存产品聊天、每轮展示事件和不透明的 Agent 运行时关联，提供 Project/Domain 隔离、分页、跨进程执行锁和中断标记。它不依赖 Kimi/Electron，也不保存或压缩模型上下文；Desktop/CLI 共用该存储。见 [聊天持久化](../../doc/chat-persistence.md)。

`append` 为新展示事件增加宿主接收时间 `recordedAt`，返回该事件供实时 UI 使用。合并连续正文时保留首个接收时间；已存储的旧事件不补造时间。该字段仅用于消息显示，不是工业状态、模型上下文或工程验证时间。

每次资源策略解析只枚举一次禁用 MCP Provider，按 Domain 建立工具集合，再筛选 Capability；资源和 Provider 仍在每次请求重新读取。`ChatStore` 在数据库连接内复用 prepared statements，并为运行中的轮次与聊天运行时关联建立索引；关闭连接时清理语句引用，持久化字段和接口保持兼容。

`SessionResourceManager` 以 SQLite 事务管理配置目录内的执行/常驻额度，默认 4/6，宿主退出后回收其租约。资源提供自己的关闭与忙碌状态回调，运行中和待用户交互的资源不自动关闭。空闲回收与跨宿主容量请求必须等物理关闭确认才释放常驻位置；该管理器不实现 Agent loop、会话上下文或工业执行。可用内存准入与压测见[多会话资源保护](../../doc/session-resource-guards.md)。

`resourceCatalog` 与 `resolveProjectTask` 接受显式注册的外部 MCP 快照，按同一资源策略把 canonical Tool ID 加入最终 Scope 并记录 Trace；不增加领域/工业 Capability。`ExternalMcpRegistry` facade 来自 domain-mcp，连接和 Gateway 留在下层包。外部结果不进入工业状态或验证，见 [外部 MCP](../../doc/external-mcp.md)。

`RemoteSettings` 与 `runtimeCapabilities` 为 Desktop/CLI 共享服务连接、项目运行位置与确认上传的文件范围。空服务配置保持“尚未配置”；Factory 在加载本地领域 Runtime 前选择远端实现。远程未准备时仍提供受控的本地工程读写与 `project.remote.plan` / `project.remote.prepare`，聊天不依赖远程连接或快照就绪。计划固定文件摘要、目的地及具名工具范围；准备经一次显式批量批准后上传。可选的记住授权仅允许后续同步同一组精确文件路径，新增文件或工具需重新批量确认；任务工具授权不绕过 Broker 或执行边界。实际可执行性仍以受保护的实时 MCP 发现为准，未知调用不自动重放。见[内置远程运行](../../doc/remote-execution.md)。

`readProjectRecords` 按已保存的项目运行位置及规范项目身份，只读访问本地事实库或远程回读缓存。该入口不要求服务凭据、快照确认或 Pack Registry，不初始化执行 Runtime；未有远程规范身份或事实库时返回 null。聊天历史和本地规划与远程执行就绪状态解耦，真正的远程调用仍检查完整配置、输入准备、实时发现和工具授权。

Trusted installed factories receive `runtimeApi: { executeTask, runtimeFiles }` from Core. This generic backend/file boundary supports plugins installed outside the workspace dependency graph. Domain semantics and Verifiers stay in their owner Pack; this API does not alter canonical persistence or authorization.
