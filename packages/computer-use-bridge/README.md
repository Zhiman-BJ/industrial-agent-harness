# Computer Use Bridge

第一个横切插件:把 [munim-computer-use](https://github.com/munimtechnologies/munim-computer-use)
(开源 Computer Use MCP server)接入 Harness,让 Kimi 在用户授权下操作桌面 GUI 应用。

## 定位

- **不进 domain 体系**:computer-use 不属于 chip/pcb,不进 `capabilities.cjs`,不占 Project 领域。
- **不进 `domain-mcp` 注册表**:那条路径是领域 EDA 工具的;GUI 工具通过 Kimi 会话 `externalTools`
  声明式注册,handler 在 Harness 手里(执行边界)。
- **enable 即授权**:插件开关开启后,"用不用、何时用"由 Kimi 决定,adapter 自动批准 GUI 工具审批,
  不再逐次询问用户。唯一系统级动作是 macOS 截屏/Accessibility 权限(由宿主应用一次性获得)。
- **横切桌面与 CLI 两条 adapter**:两边共享本包,不重复实现。

## 工具面(18 个 canonical,冻结)

`COMPUTER_USE_BROWSER=0` 下 server 恰好暴露 18 个非浏览器工具,与 `src/tools.cjs` 的
`GUI_TOOLS` 常量 1:1 对应。canonical id 列表冻结在 `doc/prototype-register.json`
(`computer-use-plugin`),由 `tests/architecture/boundaries.test.cjs` 强制比对。
`browser_*` 12 个工具不暴露(Chrome 驱动是独立能力,未纳入)。

只读工具:`list_apps`、`list_displays`、`get_app_state`、`screenshot`、`zoom`、`wait`、`clipboard_read`。
其余为变更工具(`risk: 'mutating'`),全部进 diagnostic log。

## 安装

二进制不在 npm 包里。启用插件时 adapter 调 `ensureInstalled()`:从钉定的 release
(`src/installer.cjs` 的 `DEFAULT_SOURCE`,可用 `GUI_BRIDGE_SOURCE_REPO` / `GUI_BRIDGE_TAG` /
`GUI_BRIDGE_RELEASE_BASE` 覆盖,例如 fork 到组织 repo 后)下载对应平台资产 + `SHA256SUMS.txt`,
校验 SHA-256 后解压到用户数据目录(`gui-bridge/`,目录 0o700、二进制 0o755),写 `version.json`。
幂等:同 tag 已装则复用。失败不阻塞 harness 其他功能,插件保持"未就绪"。
`GUI_BRIDGE_BIN` 可整体跳过安装直接指定已有二进制。

## 进程模型

MCP server 子进程在**首次工具调用**时懒启动,进程生命周期内复用(桌面端跨 Kimi 会话共享),
`close()` 时杀掉。stdio JSON-RPC 单调用超时 30s;响应超过 16KB 截断并附标记(与
`agent-kimi` 的 `MAX_TOOL_OUTPUT_BYTES` 一致);server 报权限缺失时返回
`{isError, needsSystemPermission: true}`,由 adapter 引导用户去系统设置授权。

## 已知缺口(登记于 prototype-register)

GUI 动作不进 Domain Runtime 的 Run/Action/Verification(现有 Runtime 只有 ObservedContextStore,
无 Action 层);调用证据目前只在 diagnostic log。替换目标:Domain Runtime Action 层统一承接
插件调用与 Verification。
