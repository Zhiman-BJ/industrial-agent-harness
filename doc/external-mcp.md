# 外部 MCP：Desktop / CLI 共用注册

当前接入：显式注册的外部 MCP 通过共享宿主 Runtime 调用，可与当前用户 Kimi 会话组合。每次调用重查审批、Scope、参数和服务快照，持久记录 Run/Action、脱敏响应和 Checkpoint；外部结果保持 not_run，不覆盖工程验收。独立应用控制插件仍受限制。[PD-088](local-agent-execution.md) 移除本机 Agent OS 隔离，不移除这些 Runtime 检查。

外部服务可显式注册一次，在 Desktop 和 Chip / PCB / Godot CLI 包中共用。支持本地 stdio、Streamable HTTP 和旧 SSE；使用固定的官方 TypeScript MCP SDK 1.30.1。不自动安装服务、软件镜像或申请操作系统授权，也不读取项目里的任意 MCP 启动配置。

## 添加和管理

Desktop：**Settings → MCP & Skills → Configure → External MCP services**。选择 Local command、Remote URL 或 Import configuration，点击 **Add and check**。添加时实际连接服务并检查工具；失败不保存部分配置。工具数量和连接类型可见，启动参数与凭据不会返回公共列表。全局默认开关和项目 Inherit / Enabled / Disabled 共用已有资源策略。

CLI，在解压包中执行：

```sh
node industrial-harness.cjs mcp add --file /absolute/path/mcp.json
node industrial-harness.cjs mcp list
node industrial-harness.cjs mcp disable external.computer-use --project-dir /absolute/project
node industrial-harness.cjs mcp inherit external.computer-use --project-dir /absolute/project
node industrial-harness.cjs mcp refresh external.computer-use
node industrial-harness.cjs mcp remove external.computer-use
```

源码入口为 `pnpm cli mcp ...`。`mcp enable|disable` 不带项目目录时修改全局默认值；`inherit` 必须指定项目。单轮还可使用 `run --disable-mcp external.computer-use`。`mcp list` 只读已存元数据，不启动服务。

本地服务配置示例，替换为已安装服务的实际命令：

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "/absolute/path/to/mcp-server",
      "args": [],
      "cwd": "/absolute/existing/directory",
      "envRefs": { "SERVICE_TOKEN": "COMPUTER_USE_TOKEN" }
    }
  }
}
```

`requestTimeoutMs` 可选，默认 30000，允许 100–3600000 毫秒，适用于实际工具调用；发现工具仍有独立短超时。

不需要认证时省略 `envRefs`。支持普通 `env` 字符串映射；引用只保存变量名称，启动时从 Harness 进程环境读取。GUI 从应用的启动环境取值，缺少变量时明确报错。stdio 只传显式环境及 SDK 的基础环境，不将完整模型密钥环境转交外部进程。`cwd` 默认固定为注册时的工作目录；对于依赖工程路径的服务，请按服务说明配置，并使用 MCP roots。

远程服务：

```json
{
  "mcpServers": {
    "remote-host": {
      "url": "https://example.com/mcp",
      "type": "http",
      "headerEnv": { "Authorization": "COMPUTER_USE_AUTH" }
    }
  }
}
```

环境值应包含完整认证值，例如 `Bearer …`。支持普通 `headers`；旧服务用 `type: "sse"`。当前不实现 OAuth 登录、安装器或其他客户端专用字段。名称最多 64 个 ASCII 字母/数字/点/下划线/连字符，资源 ID 为 `external.<名称>`；重复名称拒绝，修改连接配置需先移除再添加。

## Scope、审批和结果

通用服务在每个已有领域中可用，不生成新的工业 Capability 或 Domain。Broker 应用资源策略后，只把有效服务的 canonical Tool ID 放入 Scope 并记录 Trace。模型先获得 `external_tool_list / external_tool_describe / external_tool_call` 三个固定入口，完整响应通过 `industrial_artifact_read` 分页，工具详情按需读取。原始工具名和 canonical ID 分开，不因重名调用另一服务。

Gateway 调用前再次检查 ID、参数和当前服务的完整工具快照。发现新增、删除或 schema/描述变化时拒绝执行，要求 **Refresh tools**。配置、快照或引用环境值变化后，下一轮建立新 Kimi 会话段，保留产品历史；正在运行的 Gateway 使用固定 Scope。Desktop 禁止影响运行中聊天的配置修改；其他进程修改在下一轮生效，不承诺撤销已发出的操作。

所有外部实际调用标为 mutating，不能靠服务自报 `readOnlyHint` 绕过 Runtime 审批。CLI 默认 `--approval reject`；自动批准需显式 `--approval approve`，将批准这一轮所有待审批操作。添加/刷新会启动用户选中的程序来发现工具，因此只添加可信服务。超时或失败不自动重发操作，返回说明“执行结果可能未知”，需检查软件实际状态后再决定重试。

连接由项目 Runtime 按聊天、服务和注册版本持有，同一聊天连续调用复用连接/stdio 进程，
其他聊天独立。响应 `_harnessMcpSession` 标出会话 ID 和是否复用。每次仍重查工具快照。
关闭聊天/项目时清理服务；空闲五分钟回收连接，当前 Runtime 最多 64 个会话槽。
传输/协议失败或过期后明确返回状态丢失，不静默重建并重放操作；检查软件状态后开启新聊天。
首次传输/协议错误会关闭 SDK 连接，阻止旧 SSE 自动重连后静默替换服务会话。
操作发出前失败标记 `uncertain:false`，发出后发生传输/超限错误标记 `uncertain:true`。
CLI 进程退出也结束外部服务连接；产品聊天历史持久化不代表任意 MCP 服务状态可跨进程恢复。

PNG/JPEG/WebP 原生 MCP ImageContent 继续传给 Kimi 模型，最多四张；完整响应上限 4 MiB，超限明确失败并提示结果可能未知；截图需视觉模型，Desktop 打开 Model API 的 Image input，CLI 使用 `--image-input`。即时文字最多 64 KiB；完整响应以内容绑定的 report.external 保存，通过 industrial_artifact_read 按字节分页，单页最多 64 KiB。已知外部凭据在文本返回、缓存和诊断 JSONL 中脱敏；截图与工程资料仍按项目数据管理。

**MCP roots 是上下文，不是操作系统沙箱**。computer-use 可控制项目之外的应用；权限由服务及操作系统决定。外部返回为 `verificationStatus: not_run`，不替换 DomainState 的工程验收或产生工业验收结论。工业 Action 仍需独立 Domain Runtime / Verifier 接入，不能将外部 host 调用当作工业闭环完成。

## 持久化与验证

注册存于 `~/.industrial-agent-harness/external-mcp.json`，与同目录 `resource-settings.json` 共用；`INDUSTRIAL_HARNESS_CONFIG_DIR` 可隔离二者，CLI 管理命令支持 `--config-dir`。POSIX 文件 0600，原子替换并用跨进程锁；损坏时明确失败，不静默覆盖。项目不保存启动命令。最多 16 个服务、每个 128 个工具、总计 512 个工具；超限或不支持的 schema 拒绝注册。会话私有配置包含执行所需凭据，不写入用户 `~/.kimi`。

`pnpm test:external-mcp` 检查实际 stdio/HTTP/SSE、共享策略、越权/参数/快照变化、分页、脱敏及损坏。使用随依赖安装的 Kimi Code 2.1.1，还运行真实 Kimi 审批、拒绝后无 host 修改和 MCP 图片进入模型请求的测试。原生 CI 缺少固定内核时直接失败。

macOS Desktop：构建后运行 `pnpm --filter @industrial-agent-harness/desktop test:external-mcp`，验证实际表单添加、CLI 共享读取、项目禁用、连续两次点击及截图审批、无参分页默认值、图片输入、运行中拒绝修改、刷新/移除。发现和 schema 读取不启动服务，不请求修改审批。原生 macOS CI 强制该界面链路；受控模型与 MCP fixture 不代表任意供应商 computer-use 安装兼容性或屏幕录制/辅助功能权限已就绪。

使用宿主 Runtime 的会话不启动外部服务的 Kimi 子 MCP Gateway；同名发现/调用入口由 SDK 宿主 callback 进入 Runtime，参数可用 argumentsJson 保留数值与数组。跨进程注册变化拒绝旧调用，需开启新轮；失败、超时、取消不自动重发。桌面表单保持原有配置流程，修改服务后重建空闲 Runtime。真实 Kimi、打包 Chip CLI 及 stdio/HTTP/SSE 历史回归验证了该路径，不代表任意外部应用兼容。
