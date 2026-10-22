# Node SDK 与 stdio JSON-RPC

`@industrial-agent-harness/sdk` 是 Node.js 24+ 的 CLI 消费者。提供固定 Project/Domain、单任务事件流、取消、限时、Chat 延续与历史列表。包本身只有 Node 标准库依赖，不加载 Electron、浏览器、领域软件或 Kimi SDK；真实执行由调用方指定的无界面 CLI 完成。

源码使用、类型、JSON-RPC framing、错误和验收边界见 [SDK 文档](../../doc/sdk.md)。包还未发布到 npm；仓库测试验证源码 CLI 与进程消费链路。

When an Electron host reuses its own executable as the CLI interpreter, the SDK
sets `ELECTRON_RUN_AS_NODE=1`, including canonical path aliases. A different
configured interpreter retains its configured environment. This does not load
Electron into the SDK or change the headless CLI dependency boundary.

```js
const { createClient } = require('./packages/sdk');
const client = createClient({ cliPath: '/absolute/headless/industrial-harness.cjs', projectDir: '/absolute/project', domain: 'chip' });
try {
  const run = client.run({ task: 'Inspect netlist signals', scopeOnly: true });
  for await (const event of run.events) console.log(event);
  console.log(await run.result);
} finally { await client.close(); }
```

`result` 成功表示 CLI 完成其请求。`--scope-only` 仅预览注册表和披露，不能证明工程状态、执行授权或工程验收。真实工业事实来自 CLI 的 `industrial_result` 事件，以及其引用的版本化 Runtime 契约。

测试：`node --test packages/sdk/tests/*.test.cjs`。macOS 实测了真实 CLI/RPC、子进程与后代回收；Windows 的进程树清理实现尚未实测。

macOS 退出清理遇到进程组 `EPERM` 时，通过系统 `ps` 有界检查该组全部成员：仅组已消失或只剩退出的 zombie 时视为已结束；仍有活跃成员或无法读取状态时保留错误。此处理避免异常 CLI 退出竞态掩盖原始协议错误，仍执行后代回收，不忽略真实权限拒绝。内核行为依据 [Apple XNU 的 killpg1](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)。
