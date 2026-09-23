# Headless CLI

CLI 不启动 Electron，也不导入桌面 UI。它面向 Domain Task bench：每次运行绑定一个项目目录和一个 Domain，使用与桌面端相同的 Broker、Kimi Integration 和 Capability Registry，并逐行输出 JSON 事件。

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
