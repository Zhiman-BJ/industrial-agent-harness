# 对外 Node SDK 与自动化入口

当前实现位于 `packages/sdk`，适用于 Node.js 24+。SDK 固定一个实际存在的项目目录和一个 Domain，启动调用方指定的源码或发行物 CLI；与桌面端共用生产 Broker、Kimi 接入和 Runtime，没有另一套 Agent loop。SDK 无运行时 npm 依赖，也不加载 Electron 或 Viewer。包尚未发布到 npm。

## Node 消费方式

```js
const { createClient, HarnessError } = require('./packages/sdk');
const client = createClient({
  cliPath: '/absolute/headless/industrial-harness.cjs',
  projectDir: '/absolute/my-project',
  domain: 'chip',
  environment: { KIMI_API_KEY: process.env.KIMI_API_KEY },
});
try {
  const run = client.run({
    task: 'Run the declared RTL simulation and report the assertion evidence.',
    approval: 'reject', // 与 CLI 相同，默认拒绝需审批的工具动作
    timeoutMs: 120000,
    chatDir: '/absolute/state/chats',
    stateDir: '/absolute/state/runtime',
  });
  for await (const event of run.events) {
    // scope / chat / agent_event / industrial_result / result 等原始 CLI 事件
    console.log(event);
  }
  const result = await run.result;
  console.log(result.chatId, result.runId, result.references);
} catch (error) {
  if (error instanceof HarnessError) console.error(error.code, error.details);
  else throw error;
} finally { await client.close(); }
```

Task 以权限受限的临时文件传递，子进程不经过 Shell，结束后删除临时文件。API Key 从环境读取，不进入 CLI 参数。SDK 保留最多 16 KiB 的 stderr 尾部，并对凭据环境变量中的已知值做跨字节块脱敏。

`client.run()` 返回 `{id, events, result, cancel}`。`id` 是本次 SDK 请求标识；`result.runId` 是 CLI 任务标识；`references` 提供最后一条真实工业结果的 `industrialRunId / actionId / checkpointId`，缺失值为 `null`。这些是持久事实的引用，不是重新计算的工业对象。

每个 `events` 只有一个消费者，默认最多缓存 1,024 条事件，可通过 `maxBufferedEvents` 配置。必须在任务进行中持续消费；缓存溢出会取消任务并返回 `EVENT_OVERFLOW`。提前停止事件迭代也会取消任务。`timeoutMs` 与 `AbortSignal` 支持 SDK 层限时或取消；`await run.cancel()` 和 `await client.close()` 等待进程结束。POSIX 使用独立进程组，先请求 CLI 中断，超过默认 5 秒宽限期强制回收；父进程退出后也回收遗留后代。Windows 的 `/T /F` 清理分支尚未实测。

`client.chats({chatDir})` 列出当前 Project/Domain 的历史 Chat。调用 `client.run({task, chatId, chatDir, stateDir})` 可使用 CLI 已有的持久化会话恢复，跨 Domain 的 Chat 会被 CLI 拒绝。Checkpoint 引用不会回滚项目文件，SDK 未提供项目文件回滚接口。

`RunOptions.agentId` 可为新建或空白聊天选择角色，例如 `client.run({task, agentId: 'chip.engineer'})`，底层映射 CLI `--agent`。续聊沿用已保存角色快照，已有任务记录时不能换角色。角色的创建、编辑、删除和项目默认通过能力中心或 CLI `agents` 管理；SDK 没有配置 CRUD API。详见 [Agent 配置](agent-profiles.md)。

## 状态与契约

外层 `sdkSchemaVersion: 1` 描述 SDK 返回封套。CLI 事件保持 `schemaVersion: 1` 原形；工业对象以 `packages/contracts` 的版本化契约为准，SDK 不另造 Artifact、State 或 Verification schema。

声明中的 `TerminalCliEvent.engineering` 只描述 CLI 返回的状态引用与显示摘要。工业事件中的对象保持 `unknown`，需要操作完整对象时，调用方使用 `@industrial-agent-harness/contracts` 的 `IndustrialVerificationResultSchema.parse(event.verification)` 等 canonical schema 获取验证后的类型；SDK 不把无校验的 JSON 强制标为工业事实。

`result` Promise 成功只证明 CLI 请求正常结束。模型 turn 的 `finished`、Action 的 `completed` 和 Verifier 的 `passed` 是三个不同状态；工程验收应检查 `industrial_result.verification` 及其证据和 State。`scopeOnly: true` 只做离线注册表预览，不读取生产工程状态，不获得执行授权。

错误具有稳定 `code` 与 `details`：`INVALID_ARGUMENT`、`CLIENT_CLOSED`、`SPAWN_FAILED`、`PROTOCOL_ERROR`、`RUN_FAILED`、`TIMEOUT`、`CANCELLED`、`EVENT_OVERFLOW`、`STREAM_IN_USE`。非零 CLI 退出、缺少终结事件、非法 JSONL、未支持的事件版本都不会返回伪成功。

## stdio JSON-RPC

启动方式：

```sh
node packages/sdk/src/rpc.cjs --cli /absolute/headless/industrial-harness.cjs --project-dir /absolute/project --domain chip
```

协议是 JSON-RPC 2.0，每行一条 UTF-8 JSON，以换行结束；不使用 HTTP 或 LSP 的 `Content-Length` framing。stdout 仅输出协议，启动错误写 stderr。Project/Domain 在启动时固定，请求不能切换项目或 CLI。最大请求 1 MiB，最多四个并发 Run，最多保留 64 条已结束请求结果；过慢的输出消费者会关闭连接并取消进程。

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `initialize` | `{}` | SDK 版本、绑定项目、方法列表 |
| `runs.start` | Node `RunOptions` 的可序列化字段 | `{requestId}` |
| `runs.cancel` | `{requestId}` | 回收后返回 `{cancelled:true}` |
| `runs.wait` | `{requestId}` | `{result,error}` |
| `chats.list` | `{chatDir?,timeoutMs?}` | 当前项目的 Chat 列表 |

Run 进行中发送 `runs.event` notification：`{requestId,event}`；事件消费完毕后发送 `runs.completed` notification：`{requestId,result}` 或 `{requestId,error}`。stdin 关闭或进程收到中断时取消所有活动 Run。当前协议没有交互审批/问答通道，沿用 CLI 的显式审批策略和空回答行为。

## 已验证范围

`node --test packages/sdk/tests/*.test.cjs` 覆盖真实 CLI 的 Scope 预览、Chat 列表与 JSON-RPC consumer，以及长 Task/Unicode、非法事件、异常退出、凭据脱敏、事件溢出、取消/超时、遗留后代清理。真实模型驱动还在 `tests/benchmark/model-drivers.test.cjs` 使用固定 Kimi SDK 与本地受控提供方调用 CLI；这些受控响应证明入口工作，不能证明模型工程成功率。发行物、跨平台和付费模型任务需要分别验收。
