# 输入版本与验证有效性：第一期

2026-10-20。工程可通过 native Shell/文件工具、IDE 和外部程序修改；正式工程验证仍通过共享 Runtime 记录。本期改变版本与证据一致性，不改变 Agent 的 OS 权限或 Domain Pack 的归属。

## 已实现行为

- `industrial_state_inspect` 在当前任务中重读输入并经 Broker 刷新 scope，返回 state 和 allowedTools。观察不等于工程验证。后续 Action 仍独立检查 expectedStateId、scope、项目、工具及审批；刷新之后再次改文件仍会拒绝过期动作。
- Action/Verification 的历史结论不因后来编辑而被重写。TaskService 的结果、历史与只读 `refreshEvidence` 在返回值附加 `inputStatus`：matches、changed、unavailable 或 unchecked。桌面明确写“记录版本”，分别展示输入状态；CLI 的同源事件、历史与结果也包含该投影。
- 只读观察使用已有 canonical records，不加载 Pack、不初始化执行 Runtime、不申请远程租约、不更新 DomainState 或 Checkpoint。单请求共享文件 hash 缓存，下次请求重新读取。每次最多读取 4096 个文件、单文件 64 MiB、总计 256 MiB；链接、越界、不规则文件、读取期间变化及超限均不能得到匹配结论。changedPaths 最多展示 20 项。
- 桌面当前对话在打开、重新聚焦及可见时每 5 秒刷新最近 100 个已加载请求的证据状态。隐藏窗口暂停轮询；刷新失败显示无法核对。响应按项目/对话/导航边界丢弃，只合并证据状态，不重放成果、不清空草稿。更早的历史在读取时核对，不承诺对所有后台聊天持续扫描。
- `project.task.run` 先核对 harness.tasks.json 与已绑定输入，再解析命令与输入列表。声明输入复制前校验 hash，任务在既有隔离后端运行，完成后再次校验副本。只有同一进程内可信生产者为本 Action 绑定的结果才会持久记录 `inputBinding: snapshot`，JSON 参数不能声明这个保证。副本改变时拒绝采信检查；仅工作区改变时保留副本的历史 verdict，当前 DomainState 为 stale。
- 未迁移的生产者保持原有保守处理：执行期间输入变化时为 insufficient_evidence。它们不会因新增字段被自动视作快照执行。远端适配器、领域包 pin 与原生 Agent 隔离策略未在本期改动。
- 将通过验证的结果选作当前版本前，会重新核对其记录输入；已变化或无法确认的输入拒绝该选择。显式历史选择仍允许，输出打开仍独立检查产物 hash。选择或预览本身不产生工程验收。
- `project.files.apply` 保留已有批次预检、单次写入前复检和回滚时的 hash 检查。本期加入“暂存期间发生外部写入”的回归，确认停止后不会把外部的新内容恢复成旧版本。

## 保证边界

matches 严格表示“已记录的输入文件仍匹配”，不是“整个工程已通过”。它不证明新增加的文件、未声明依赖、环境、工具安装树或读目录没有变化；缺失输入映射为 unchecked。正式执行仍需当前 StateProvider 与 verifier。轮询是有延迟的观察，不是文件锁。

这里的 snapshot 指声明式任务实际复制的输入。历史 Action 的输入映射还可包含被索引但未被该任务使用的文件；并未为整个工程保存可恢复的源码快照。Checkpoint 继续是状态和证据记录，不新增源码 restore/replay。所有领域的输入闭包、执行快照与恢复需在各自 owner 继续实施。

本机同用户进程仍有修改源文件、临时副本甚至 Runtime 存储的可能。校验与只读模式用于发现版本不一致，不构成对同权限恶意进程的防篡改证明，也不是跨任意写入者的原子 compare-and-swap。未来 OS 沙箱可限制这些写入入口；版本绑定和历史展示仍应保留。

## 验证

真实任务可在本机终端一次执行 `node scripts/verify-workspace-sandbox.cjs`。它保留严格的通过/失败/阻塞区分、实际 canonical records 和检查报告；操作与边界见[真实沙箱验收](qa-runbook/workspace-sandbox.md)。

新增回归覆盖原生同尺寸编辑和恢复 mtime、删除/不安全路径、空输入、快照与非快照并发变更、伪造绑定拒绝、任务声明竞态、回写及回滚冲突、只读历史与跨聊天/项目拒绝、scope 刷新和界面合并时保留新事件/历史 verdict。真实声明任务及 Desktop selftest 增加相应情景，仍要求在可运行本地任务隔离与 MCP 服务的环境验收。

本轮环境的 sandbox-exec 返回 `sandbox_apply: Operation not permitted`，本地 MCP 监听返回 `listen EPERM 127.0.0.1`，因此不将真实任务与完整 Desktop 链路记为通过。架构所有权 checker 通过；候选物化测试的 `spawnSync git ENOBUFS` 在未修改的基线同样复现，未调整门禁。实际命令及结果见本次提交说明。

| 本轮检查                                                                                                                                                                      | 实际结果                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 定向回归：contracts 全部；Runtime evidence-inputs/workspace/industrial-read-only/presentation；TaskService 与 results；Kimi runtime-tools；Desktop result-layout/chat-history | 80 项，79 通过，1 项 MCP bridge 因本机监听 EPERM 失败；无跳过                        |
| `pnpm --filter @industrial-agent-harness/desktop build`                                                                                                                       | 类型检查与生产构建通过                                                               |
| `pnpm lint`、改动代码 Prettier 检查、`git diff --check`                                                                                                                       | 无错误；全仓 Lint 保留 92 项 warning                                                 |
| `pnpm test:architecture-contract`                                                                                                                                             | 所有权 checker 通过；测试 19/20，候选物化 ENOBUFS 在基线复现                         |
| `pnpm test:architecture`                                                                                                                                                      | 47/48，同一候选物化失败                                                              |
| workspace-runtime 的真实 protected local task 用例                                                                                                                            | 在首个真实任务处失败；本环境无法创建 Seatbelt 沙箱，新增并发输入情景未获原生通过证据 |
| Desktop task-results selftest                                                                                                                                                 | 已增加外部编辑与草稿保留情景；本轮未完成完整 Electron/MCP/FreeCAD 验收               |
