# Headless CLI

CLI 不启动 Electron，也不导入桌面 UI。它面向 Domain Task bench：每次运行绑定一个项目目录和一个 Domain，使用与桌面端相同的 Broker、Kimi Integration 和 Capability Registry，并逐行输出 JSON 事件。

## GitHub Release 安装

打开 [GitHub Releases](https://github.com/Zhiman-BJ/industrial-agent-harness/releases)，下载最新 `headless-v*` 预发布版本中的 `industrial-agent-harness-headless-<tag>.tar.gz` 和同名 `.sha256` 文件。需要 Node.js 22 或更新版本；使用下载包无需克隆仓库或安装 pnpm。

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

打包目录包含 CLI、Broker、仓库 Skill 文件、MCP 注册表和 Kimi SDK 接入；不包含 Electron、Kimi CLI 或工业可执行文件。当前默认 MCP 服务器注册表为空，所以打包只保留 MCP 接入机制，不能据此声称已能运行实际 Domain MCP Tool。真实 Agent 场景还需配置 `KIMI_EXECUTABLE` 和模型 API Key。

每个 `headless-v*` Release 正文都列出该版**相比原生 Kimi Code 实际集成的 Harness 能力**及尚未集成的部分；发布时使用仓库中与标签同名的 `releases/<tag>.md`，不复用上一版说明。

`examples/bench/rtl-verification-target.json` 是目标场景断言，现阶段预期失败：Broker 没有 `chip.rtl.simulate` 能力。它用于追踪首条真实 RTL 验证闭环的进度，不应作为已通过的 CI gate。

```bash
pnpm cli run --project-dir ./examples/chip-sobel --domain chip --task 'Inspect the netlist signals' --scope-only
```

`--scope-only` 只输出能力 Scope 和披露 Trace，无须模型密钥。运行 Agent 时，先通过环境变量配置模型密钥及 Kimi 可执行文件：

可重复传入 `--disable-skill chip.netlist.inspect` 或 `--disable-mcp SERVER_ID`，在该次 Bench 运行中应用与 Project 详情页相同的资源策略。未知资源 ID 会报错；默认 MCP 服务器列表目前为空。

```bash
KIMI_API_KEY=... KIMI_EXECUTABLE=/path/to/kimi pnpm cli run \
  --project-dir ./examples/chip-sobel --domain chip \
  --task-file ./task.txt --model kimi-k2-thinking-turbo \
  --approval reject --timeout-ms 600000
```

输出为 JSON Lines，每条含 `schemaVersion` 和 `runId`。首条 `scope` 带 Broker Scope、匹配能力及 L0–L3 披露 Trace；后续为 `agent_event`、按需 `disclosure` 和最终 `result`。`--approval` 可选 `reject`、`approve`、`approve_for_session`，默认拒绝。密钥只从环境变量读取，不作为命令行参数传入。

可用 `--artifact-manifest FILE` 提供 Viewer 之外的工件元数据。文件为 `{id, kind, path}` 对象数组，路径必须位于项目目录内；CLI 记录内容哈希，并在工具调用时重新核验。CLI 的读取不代表工程验证通过。
