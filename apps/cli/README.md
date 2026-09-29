# Headless CLI

CLI 不启动 Electron，也不导入桌面 UI。它面向 Domain Task bench：每次运行绑定一个项目目录和一个 Domain，使用与桌面端相同的 Broker、Kimi Integration 和 Capability Registry，并逐行输出 JSON 事件。

## GitHub Release 安装

打开 [GitHub Releases](https://github.com/Zhiman-BJ/industrial-agent-harness/releases)，下载最新 `headless-v*` 预发布版本中的 `industrial-agent-harness-headless-<tag>.tar.gz` 和同名 `.sha256` 文件。当前源码接入的 SQLite 观察状态需要 Node.js 22.13 或更新版本；使用下载包无需克隆仓库或安装 pnpm。

```bash
sha256sum -c industrial-agent-harness-headless-<tag>.tar.gz.sha256
tar -xzf industrial-agent-harness-headless-<tag>.tar.gz
node headless/industrial-harness.cjs run \
  --project-dir /path/to/project --domain chip \
  --task 'Inspect netlist signals' --scope-only
```

macOS 可用 `shasum -a 256 -c` 代替 `sha256sum -c`。解压后整个 `headless/` 目录可移动，运行时不依赖原仓库。真实 Agent 运行还需单独安装 Kimi CLI，并设置 `KIMI_EXECUTABLE`、`KIMI_API_KEY`；当前 Release 仅发布无 UI Harness，不包含工业软件。发布工作流在 Linux 上解压并烟测；其他系统尚无 Release 包测试承诺。

## 开发与场景 Suite

从源码可生成同样的无 UI 目录（打包机需要 pnpm）：

```bash
node scripts/package-headless.cjs
node dist/headless/industrial-harness.cjs bench --suite examples/bench/scope-smoke.json --output-dir /tmp/industrial-bench-results
```

`bench` 读取 JSON suite，顺序运行多个 `run` 场景，逐场保存 JSONL，并生成 `summary.json`；断言失败时返回非零退出码。Suite 中 `projectDir` 和可选的 `artifactManifest` 相对于 suite 文件定位。每个场景可设置 `scopeOnly`、`disabledSkills`、`disabledMcpServers`、`timeoutMs`，并在 `expected` 中断言 `status`、`capabilityIds`、`skills`、`tools`、`mcpServers`。请使用全新的输出目录，避免覆盖先前证据。`examples/bench/scope-smoke.json` 是当前能力基线，其中 RTL 验证请求解析为空，表明该能力链尚未实现。

打包目录包含 CLI、Broker、仓库 Skill 文件、MCP 注册表、Kimi SDK 接入与只读观察状态存储；不包含 Electron、Kimi CLI 或工业可执行文件。当前默认 MCP 服务器注册表为空，所以打包只保留 MCP 接入机制，不能据此声称已能运行实际 Domain MCP Tool。真实 Agent 场景还需配置 `KIMI_EXECUTABLE` 和模型 API Key。

如需先测试完整芯片 MCP 工具集，请安装独立的 [Chip Pack Release](https://github.com/Zhiman-BJ/industrial-agent-harness/releases/tag/chip-v0.6.0-preview.1)。它与本 CLI 的 Broker Scope 尚未连接，使用和验收路径见 [Chip Pack 文档](../../domain-packs/chip/README.md)。

每个 `headless-v*` Release 正文都列出该版**相比原生 Kimi Code 实际集成的 Harness 能力**及尚未集成的部分；发布时使用仓库中与标签同名的 `releases/<tag>.md`，不复用上一版说明。

`examples/bench/rtl-verification-target.json` 是目标场景断言，现阶段预期失败：Broker 没有 `chip.rtl.simulate` 能力。它用于追踪首条真实 RTL 验证闭环的进度，不应作为已通过的 CI gate。

```bash
pnpm cli run --project-dir ./examples/chip-sobel --domain chip --task 'Inspect the netlist signals' --scope-only
```

`--scope-only` 只输出能力 Scope 和披露 Trace，无须模型密钥。运行 Agent 时，先通过环境变量配置模型密钥及 Kimi 可执行文件：

模型 API 端点默认要求 HTTPS（localhost 除外）。自托管明文 HTTP 端点需在 `HARNESS_TRUSTED_PLAINTEXT_HOSTS` 中显式声明，逗号分隔，条目为 `host` 或 `host:port`（host 与 port 都匹配、只有 host 匹配时任意端口有效），例如 `HARNESS_TRUSTED_PLAINTEXT_HOSTS=192.168.1.50:48000`。桌面端与 CLI 共用同一校验。

## Computer Use 插件（`--enable-gui`）

`--enable-gui` 启用横切的 computer-use 插件：让 Kimi 在授权下操作桌面 GUI 应用。首次启用时自动从 [munim-computer-use](https://github.com/munimtechnologies/munim-computer-use) 的钉定 release（`v0.4.3`，见 `packages/computer-use-bridge`）下载对应平台二进制，校验 `SHA256SUMS.txt` 后安装到 `~/.industrial-agent-harness/gui-bridge/`（`GUI_BRIDGE_DIR` 可覆盖），已装则跳过；安装过程以 `gui_install` 事件输出（checking/downloading/verified/ready/error）。安装失败会使本次运行报错退出，不写入任何半成品。启用即授权：GUI 工具审批由 Harness 自动以 `approve_for_session` 应答，`--approval` 策略只作用于非插件工具。

- macOS 首次使用需在 系统设置 → 隐私与安全性 → 辅助功能/屏幕录制 中为**运行 CLI 的终端应用**授权一次（也可在终端运行 `~/.industrial-agent-harness/gui-bridge/munim-computer-use request-permissions` 触发系统弹窗）。
- `GUI_BRIDGE_BIN=/path/to/munim-computer-use` 跳过自动安装直接使用既有二进制；`GUI_BRIDGE_SOURCE_REPO` / `GUI_BRIDGE_TAG` / `GUI_BRIDGE_RELEASE_BASE` 可整体替换安装源（例如 fork 后发布自己的 release）。
- 插件不进 Domain 体系、不依赖当前项目；关闭方式即不加该旗标。

可重复传入 `--disable-skill chip.netlist.inspect` 或 `--disable-mcp SERVER_ID`，在该次 Bench 运行中应用与 Project 详情页相同的资源策略。未知资源 ID 会报错；默认 MCP 服务器列表目前为空。

```bash
KIMI_API_KEY=... KIMI_EXECUTABLE=/path/to/kimi pnpm cli run \
  --project-dir ./examples/chip-sobel --domain chip \
  --task-file ./task.txt --model kimi-k2-thinking-turbo \
  --approval reject --timeout-ms 600000
```

输出为 JSON Lines，每条含 `schemaVersion` 和 `runId`。首条 `scope` 带 Broker Scope、匹配能力及 L0–L3 披露 Trace；后续为 `agent_event`、按需 `disclosure` 和最终 `result`。`--approval` 可选 `reject`、`approve`、`approve_for_session`，默认拒绝。密钥只从环境变量读取，不作为命令行参数传入。

可用 `--artifact-manifest FILE` 提供 Viewer 之外的工件元数据。文件为 `{id, kind, path}` 对象数组，路径必须位于项目目录内；CLI 记录内容哈希，并在工具调用时重新核验。CLI 的读取不代表工程验证通过。

每次 Agent 运行会发出 `diagnostic-log` 事件，指向完整 JSONL 诊断日志。日志包括 Broker Trace、实际提示词、SDK 暴露的原始事件、完整工具返回、压缩事件、审批和上下文统计；界面展示的长结果仍会缩短。默认日志位于 `~/.industrial-agent-harness/logs/`，观察状态数据库位于 `~/.industrial-agent-harness/state/`，可用 `--log-dir`、`--state-dir` 或同名 `INDUSTRIAL_HARNESS_LOG_DIR`、`INDUSTRIAL_HARNESS_STATE_DIR` 环境变量覆盖。日志文件权限为 `0600`，目录为 `0700`，已知模型 API Key 会脱敏；日志仍可能包含用户任务、思考内容和工具读取的工程数据，应按项目资料管理。`bench` 将两者放在输出目录下。

用 `node industrial-harness.cjs inspect-log --file /path/to/trace.jsonl` 可检查事件序号是否完整，并查看模型、Scope、工具调用与完整返回字节数、上下文占用和压缩次数；原始 JSONL 保留全部 SDK 可见内容。

每轮还保存固定 Kimi CLI 的 `context.jsonl` 和 `wire.jsonl` 快照，日志中记录路径、大小与哈希；可据此检查压缩后的实际会话内容。快照失败会显式记入诊断日志。

观察状态保存登记工件的路径、SHA-256 和最小 Checkpoint，并在下一轮或新进程中重新核验。`industrial_context_read` 可分页读取历史 Checkpoint；其内容只代表文件观察，`verificationStatus` 始终是 `not_run`。完整的 DomainState、Run、Action 与工程 Verifier 不属于这一只读接入。

CLI 与 Desktop 共用 `~/.industrial-agent-harness/resource-settings.json` 的全局 Skill/MCP 默认值及按真实项目目录绑定的覆盖；可用 `INDUSTRIAL_HARNESS_CONFIG_DIR` 隔离配置目录。项目显式启用或禁用优先于全局，未配置则继承。`--disable-skill` / `--disable-mcp` 最后应用，可为本次运行进一步禁用资源。Bench 要固定基线时请指定独立配置目录。配置损坏会明确报错，不会自动覆盖。

## 持久聊天

真实 Agent run 默认保留聊天，在 `chat` 与 `result` JSONL 中输出 `chatId`。`chats --project-dir DIR --domain DOMAIN` 列出同一项目的聊天，`run ... --chat-id UUID` 继续最近的兼容 Kimi 会话段。Desktop/CLI 默认共用 `~/.industrial-agent-harness/chats`；`--chat-dir` 或 `INDUSTRIAL_HARNESS_CHAT_DIR` 可隔离存储。`--scope-only` 不创建聊天。模型、Scope 或 MCP 策略变化时建立新段并保留展示历史；历史读取不会执行工具。详见 [聊天持久化](../../doc/chat-persistence.md)。
