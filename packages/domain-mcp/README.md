# Domain MCP

Exposes domain capability discovery, selected tool schemas, and calls backed by the domain runtime. Keep discovery compact and disclose detailed tools only as needed for a task.

当前 `src/index.cjs` 提供仓库默认服务器注册、按 Scope 与全局/项目有效禁用项筛选及 Kimi 会话 `mcp.json` 生成；尚未注册真实默认服务器。首个服务器需要明确 Domain、稳定 ID、固定版本和它实际暴露的全部 canonical Tool ID。若服务端可能返回未声明工具，需先通过 Gateway 限定工具面，再将其加入默认注册表。Settings 与项目详情页提供资源配置入口，只保存 ID 启用策略，项目支持继承、启用与禁用，不改用户全局 Kimi 配置。当前列表为空，不支持添加自定义服务器。
