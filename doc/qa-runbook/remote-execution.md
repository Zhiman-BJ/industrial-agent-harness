# RE：远程执行

本机 Agent 按 [PD-088](../local-agent-execution.md) 在三平台使用当前用户权限；远端验收不再以本机 Seatbelt/bubblewrap 为聊天启动前提。远端认证、租户/项目隔离、软件资格、快照与产物校验及沙箱释放仍是独立必验项，浏览器健康响应或本机启动成功均不能替代完整链路。

依据：[内置远程运行](../remote-execution.md)、[平台账号](../platform-account.md)、PD-079 与 [PD-089](../product-decisions.md#pd-089远程任务在对话中规划与批量准备)。官方远程配置仍为空；空配置时聊天及本地工程规划可用、真正的远程执行被阻止是可以通过的产品用例。不要把历史 H200 内网 RTL 证据当成生产账号已联通。先走[协议](protocol.md)，使用经授权的测试部署与专用工程。

## 本次状态与验收口径

**后续更新：** 用户已启动独立 mock 模型窗口，配置前置已具备；当前阻塞变为原生窗口控制接口持续超时，尚未发送任务或点击审批。见[独立窗口后续记录](../evidence/remote-chat-first-20261019/electron-click-20261020/isolated-window-followup.md)。下段保留此前入口子项验证过程。

**2026-10-20 最新进展：真实 Electron 窗口与未同步聊天入口已验证，完整点击验收仍为 `blocked`。** 用户在正常 Terminal 启动应用后，已通过 CUA 原生界面创建独立 CAD 工程、选择远端并直接新建聊天，没有选择同步文件；“按需准备文件”和“请求审批”均实际显示。已填写合成任务并观察到发送按钮可用，随后清空草稿，未点击发送。RE-E01 的窗口、聊天入口及输入/发送可用子项通过，但尚未发送或读取本地工程，**完整 RE-E01 不能记 pass**。准备 mock 时发现当前 profile 的单槽密钥已有 MiniMax 配置，已取消而未保存；RE-E01 剩余部分及 RE-E02–11 当前为 `blocked: isolated-ui-model-profile-required`，待独立 UI 模型 profile 启动。无本轮上传、审批或远端工程调用；负向 fixture 的额外前置限制仍保留。见[本轮点击进展与截图](../evidence/remote-chat-first-20261019/electron-click-20261020/README.md)及[逐用例 JSON](../evidence/remote-chat-first-20261019/electron-click-20261020/progress.json)。当前工作区为 `546b41`，实际窗口使用此前 `a283` / `cf15` 的源码构建，身份范围详见记录。

**早期有界启动探测（保留历史，已非当前窗口阻塞）：** 锚定提交为 `a283fec5bbe47dbdd1c263da38c25258b4a95105`，仍须结合本次 dirty 快照理解测试对象。常规 `pnpm --filter @industrial-agent-harness/desktop build` 因共享依赖缺少 `.bin` 的 `tsc` 入口未启动；随后直接使用实际 package bin 执行 TypeScript 7.0.2 `--noEmit` 与 Vite 8.2.2 build，均退出 0。构建当前源码后，Electron 44.0.0 的 `. --remote-ui-selftest` 子进程仍以 `SIGABRT` 结束，`status: null`、stderr 为空，探测于 `05:35:37Z` 结束。前后均未观察到运行中的 Harness 窗口，未进行真实审批或成果点击。本轮没有新的 `_RegisterApplication` 堆栈证据。[本轮持久化探测记录](../evidence/remote-chat-first-20261019/electron-click-readiness-20261020.json)归档了构建、启动和窗口缺失事实；原始记录位于 `dist/ci-reports/electron-click-probe-20261020-qaJpFl/report.json`；本轮因缺少可用窗口记为 blocked，不是点击用例通过；崩溃根因未由此次探测确认，无需循环重试。

已有 [2026-10-20 真实共享链路验收](../evidence/remote-chat-first-20261019/current-user-and-model-mock-20261020.md)及[规范验收摘要](../evidence/remote-chat-first-20261019/live-acceptance-20261020/acceptance.json)：真实 TaskService/Kimi 2.1.1、本地 mock 模型、真实部署，两次 CAD、自动重新同步、一次 batch 加一次 local edit 审批、报告读取和确认释放均通过。其模式明确为 **no Electron**，不能填入以下 Electron 点击用例的 pass，也不能证明真实模型自主规划。

| 执行组合                                                             | 可以证明                                                 | 不能代替                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| 实际 Electron 窗口 + 真实 Kimi + 明确标注的本地 mock 模型 + 真实远端 | UI 入口、真实鼠标/键盘审批、共享任务链路及该部署工程结果 | 真实模型自主选择依赖/工具的能力                          |
| 实际 Electron 窗口 + 真实模型 + 真实远端                             | 该任务实际模型与 UI 到远端的整条路径                     | 其他平台、领域、任务或正式发行资格                       |
| Headless TaskService/Kimi + 任一模型 + 真实远端                      | 共享层与远端的对应行为                                   | Electron 窗口、控件、点击、Renderer/IPC、Viewer 实际显示 |
| Electron UI selftest + 受控远端或预填历史                            | 控件与 fixture 状态的回归                                | 真实上传、远端工业调用、现场审批或真实工程结果           |

## 自动命令

```sh
node --test packages/harness-core/tests/remote.test.cjs packages/harness-core/tests/account-remote.test.cjs apps/cli/tests/remote.test.cjs
node --test packages/harness-core/tests/remote-preparation.test.cjs packages/harness-core/tests/current-remote-runtime.test.cjs packages/agent-kimi/tests/approval.test.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:ui
```

这些属于 T1/T2，覆盖受控 HTTP 服务、共享配置、固定身份、上传同意和事实校验，不需要真实生产凭据。`remote-ui-selftest` 的预填聊天/受控服务也只能记相应 UI 回归，不能代替下面的真实部署点击验收。真实平台配置与 Token 只能在宿主提供；不得写进日志、仓库或截图。

CLI 手工高级路径（将工程、领域、文件替换为专用验收输入；桌面对话无需先走此路径）：

```sh
node apps/cli/src/main.cjs remote status
node apps/cli/src/main.cjs remote connect
node apps/cli/src/main.cjs remote use --project-dir /path/to/project --domain chip --location remote
node apps/cli/src/main.cjs remote sync --project-dir /path/to/project --domain chip --file eda.yaml --file rtl/counter.sv
```

最后一条只预览；审核目的地、项目、精确文件摘要后才对同一清单加 `--confirm-upload`。实际执行会运行专业任务，须有有效模型配置和该部署认可的 Pack/profile：

```sh
node apps/cli/src/main.cjs run --project-dir /path/to/project --domain chip --task '运行远程验证' --approval approve
node apps/cli/src/main.cjs remote session --project-dir /path/to/project --domain chip --chat-id CHAT_UUID
node apps/cli/src/main.cjs remote task --project-dir /path/to/project --domain chip --chat-id CHAT_UUID
node apps/cli/src/main.cjs remote terminate --project-dir /path/to/project --domain chip --chat-id CHAT_UUID --session-id APPLICATION_SESSION_UUID
```

## 手工矩阵

| ID                  | 步骤与预期                                                                                                                                                                                                              | 边界／失败恢复                                                                                                                                              | 必留证据                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| RE-01 聊天优先      | 项目详情点击“知满远程（体验）”（选项直接保存运行位置，无另一个保存按钮），项目详情与侧栏均可进入聊天，重启后复用已有空白聊天；在本地模型/Agent 可用时，远端未配置、离线、未同步或查询失败仍可发送并本地读写工程         | 执行状态如实显示阻塞原因，真正远程工具调用被阻止；不自动填官方 URL 或上传整个工程；无项目、领域或本地 Agent 不可用的原有条件保留                            | 聊天输入和发送状态、本地读写结果、远端调用/上传次数                                |
| RE-02 身份连接      | 配置授权的 HTTPS 部署，检查连接并固定 serverId/远端项目/subject；在任务运行时改变设置                                                                                                                                   | URL 禁凭据和重定向，非 loopback HTTP 拒绝；绑定变化不得把现有任务发往另一服务/账号                                                                          | 脱敏 origin、固定身份一致性、拒绝记录                                              |
| RE-03 对话计划/准备 | Agent 先阅读工程，再用 `project.remote.plan` 选择任务文件和具名工具；计划不上传。`project.remote.prepare` 展示固定路径、大小、manifest 摘要、目的地、工具及计划中的记住策略，显式批准一次后上传；自动审批模式重复此用例 | 拒绝不上传；批准前改 bytes/目的地/绑定或等待五分钟使计划失效。空清单、>256 文件或 >8 MiB、越界/软硬链接/常见私钥凭据拒绝；不声称领域依赖解析或通用敏感识别  | 不可变审核摘要、批量审批事件、上传次数、拒绝原因；不附秘密                         |
| RE-04 正常任务      | UI 和内部 CLI 各用相同 Pack/profile/input 走准备→实时发现→调用→收集→结束，核对 canonical 事实和 CAS hash                                                                                                                | 静态目录/profile 清单不代表执行就绪，受保护的实时描述失败则不调用；执行结束不等于 Verification passed；当前 MCP 回执由本地规范记录包装，不伪造服务端事实    | invocation、远端 receipt 与本地 Action/Artifact/Verification/Checkpoint 关联、hash |
| RE-05 任务工具范围  | 批准一批工具后，同一任务的范围内工具无需重复审批；新增工具、新任务、拒绝审批、过期 scope、直接绕过准备分别尝试                                                                                                          | 执行边界仍检查项目/领域/身份/任务/Tool ID，不能把一次准备视为全局许可；专业工具不走本地 fallback；凭据不进入 renderer/Agent 环境                            | 一次批量批准、范围内执行次数、越界拒绝、脱敏环境检查                               |
| RE-06 断线恢复      | 提交后断开宿主/网络，重启查看持久调用状态；另试未知结果、待导入、篡改下载、过期 State                                                                                                                                   | 支持查询的协议按 invocation ID 查询；当前 MCP 无调用状态端点时保持 unknown，禁止自动重放、重绑、自动同步或另路重做；大小/hash/事实绑定失败不导入通过        | journal、实际提交次数、协议查询能力、未导入原因                                    |
| RE-07 停止与退出    | 中断本地等待，查询会话；空闲时显式结束，并检查服务确认状态。登录退出/切换账号后查看既有任务                                                                                                                             | 停止等待不表示远端取消；busy/unknown/待导入不得冒充已释放；退出不停止任务、不丢身份，换账号不迁移项目                                                       | invocation/session ID、服务终态、清理与恢复记录                                    |
| RE-08 记住精确文件  | 默认启用记住并批准后，修改已批准路径，再调用远程工具；应自动同步新内容且不再询问同组文件。重启后重复；由 Agent 以 `remember:false` 重新规划后重复（审批卡没有独立记住开关）                                             | 新建或额外引用文件不自动上传，新增路径或工具需一次新的批量确认；目的地/身份变化及未知调用阻止自动同步。关闭记住时，内容变化要求新计划；快照仍按新 hash 冻结 | 批准与同步策略、每次 manifest/hash、实际上传路径、重启后结果                       |
| RE-09 手工高级入口  | 从项目执行设置手动选文件、审核并上传；对照聊天准备的目的地和文件边界；另测重绑及产物下载                                                                                                                                | 手工上传不自动授予任务工具范围，也不默认授权后续内容同步；下载不覆盖已有源码；入口可选，不能成为聊天前置条件                                                | 手工审核、上传策略、下载目标及摘要                                                 |

## Electron 点击验收准备

本节用例编号为 `RE-E01`–`RE-E11`，与上面的通用协议矩阵分别记录。先按[执行协议](protocol.md)保存完整 SHA、dirty 快照、OS/arch、Node/Electron/Kimi、包与固定 Pack/profile 身份，并在本次独立证据目录记录 `modelService: real|local-mock`、`remoteService: real-deployment`、应用是 source 还是 packaged。不能把源码窗口结果记成已签名安装包验收。

1. 使用有正常图形桌面、可运行目标 Electron/Kimi 的受支持平台。源码入口先构建当前 checkout，再用 `pnpm --filter @industrial-agent-harness/desktop start` 打开正常应用；安装包入口记录实际包路径与版本。真实点击链路不加 `--remote-ui-selftest` 或其他预填 fixture 标志。不能通过关闭 Electron 安全隔离或绕开认证来把启动阻塞改成通过。
2. 使用专用、无客户秘密的合成 CAD 工程和独立验收账号/配置。`recipe.json` 可采用 `scripts/qualify-remote-chat.cjs` 中已验证的合成配方；记录初始 bytes/hash 与允许的一次确切修改。新建本次 project/chat，不复用 headless 成功 run 的授权、snapshot、session 或 Action ID。通过应用正常平台账号流程连接已授权部署；健康检查、实时发现与专业验证分别记录。
3. 模型可用真实服务，或明确使用 `scripts/remote-chat-model-fixture.cjs` 导出的 `startRemoteChatModelFixture()`。该模块仅提供单对话、严格11步的模型服务，不是自动接入桌面的 CLI；当前没有已验收的 Electron fixture bootstrap。mock 点击验收必须先准备能维持 keyed `127.0.0.1` 服务、私下传递本次 key 且不程序化批准的接线；前置未具备时记 `blocked: model-fixture-bootstrap-unavailable`，不能宣称即插即用。接线具备后在实际“Model API / 模型 API”设置填写 `OpenAI-compatible`、返回的 API base URL、模型 `remote-chat-controlled-fixture` 和本次私有 fixture key，点击 Save。记录使用 mock，只替代模型响应；不要把 key、登录码或 Token 放入截图、日志或仓库。fixture 只接受 `/v1/chat/completions`，额外模型连接测试/探测请求可能消费或破坏严格序列，不能先跑一次试探推理再沿用该会话。远端必须仍为真实授权部署，不用 `remote-ui-fixture`、mock transport、假回执或预写 Action 代替。`qualify-remote-chat.cjs` 的 headless runner 会程序化批准，不作为 Electron 点击驱动运行；只能参考其合成输入与只读断言。
4. 主成功链路使用“请求审批 / Request approval”。在一个用户任务内要求读取配方→计划并准备→首次 CAD→对已批准路径做一次确定修改→第二次 CAD→读取报告→报告实际 Action ID。两次工程调用必须属于同一任务，才能验证批量工具授权复用；分成两个新用户任务会要求新的任务授权，不能拿来证明该用例。
5. 通过实际窗口控件点击；辅助自动化必须基于可见窗口/可访问性/当前控件定位并保留截图。不能从 DevTools、`executeJavaScript`、preload API、直接 IPC 或 `TaskService.approve` 注入批准后宣称用户点击通过。只读日志、canonical 查询和文件 hash 校验可辅助取证，不替代 UI 操作。

### 已核对的控件

控件文字以当前 UI 语言为准；下列英文是源码标识，中文来自 `apps/desktop/i18n.config.json`。测试前再核对窗口，控件缺失或禁用时记录实际原因，不臆造另一条入口。

| 操作           | 实际入口                                                                                                                                                   | 源码                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 运行位置与聊天 | 项目详情“运行位置 / Execution location”→“知满远程（体验） / Zhiman Remote (trial)”；详情或侧栏“新建聊天 / New chat”                                        | `ProjectDetails.tsx`、`RemoteExecution.tsx`、`App.tsx` |
| 发送任务       | “工程任务 / Engineering task”输入框；“发送任务 / Send task”图标按钮，或 Enter（Shift+Enter 换行）                                                          | `App.tsx`                                              |
| 审批模式       | composer 的“请求审批 / Request approval”或“自动批准 / Auto approve”下拉框                                                                                  | `App.tsx`                                              |
| 批量与编辑审批 | 对话中的通用审批卡，“批准 / Approve”或“拒绝 / Reject”；批量预览标题为“Approve remote task / 批量授权远端任务”                                              | `AgentFlow.tsx`、`remote-planning-runtime.cjs`         |
| 远端状态       | 聊天右上状态入口→“远程环境 / Remote environment”；可进入“文件与执行设置 / Files and execution settings”                                                    | `ChatStatusCard.tsx`                                   |
| 成果           | 成果卡“打开 / Open”（aria/title 为 `Preview result` 或 `Open result`）、“文件（N）”、检查详情；文件夹图标为“在文件夹中显示原生文件 / Show native file”     | `TaskResults.tsx`                                      |
| 手动下载与结束 | 项目执行设置“浏览远程产物 / Browse remote results”→“下载到项目 / Download to project”；状态卡仅在实际空闲且未终止时提供“结束远程会话 / End remote session” | `RemoteExecution.tsx`、`ChatStatusCard.tsx`            |

批量审批展示目的地、每个路径及大小、manifest SHA-256、具名工具和“自动同步以上文件的后续修改”或“仅上传本次版本”。逐文件 SHA 可与不可变计划记录对照。`remember` 来自 Agent 的 plan 输入，**审批卡没有记住复选框**；要改变策略应拒绝并要求重新规划。项目设置的“审核上传 / Review upload”“确认并同步 / Confirm and sync”属于手工高级入口，不能拿这次点击代替聊天中的批量批准。

### Electron 点击矩阵

| ID                              | 实际点击与预期                                                                                                                                                                          | 事实与计数核对                                                                                                                                                                                                                             | 截图/证据                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| RE-E01 未同步聊天               | 新工程点击远端运行位置，不进入手动选文件；从项目详情点击新建聊天并输入任务。另以独立未配置配置/未同步工程验证侧栏入口；已有空白聊天时允许复用，侧栏按钮因空白聊天去重而禁用不算远端阻塞 | 尚无 snapshot、零上传；模型/Agent 可用时能发送并读取本地工程。未配置/离线只阻止远端调用，不阻止本地规划；不得修改工作中的部署制造故障                                                                                                      | `01-unsynced-chat.png`、输入/发送状态、上传前绑定及网络计数                                           |
| RE-E02 计划停在审批             | 点击发送；真实 Kimi 读取工程并生成计划，等待批量审批卡，不先点任何上传按钮。滚动查看完整预览                                                                                            | 待批准期间零上传/零远端工业调用；目的地、文件、工具、manifest 与本任务计划一致；默认 remember=true 明示                                                                                                                                    | `02-batch-pending.png`、plan artifact、reviewId、approvalId；长预览分段截图                           |
| RE-E03 一次批量批准             | 在对应批量卡真实点击一次“批准”，观察按钮提交状态与已批准记录；展开远端状态                                                                                                              | batch=1；一次批准后上传、实时描述与准备释放成功，未完成准备不得报告 ready。首次 CAD Action completed 且 Verification passed，来源 receipt 可查；工程会话确认 released                                                                      | `03-batch-approved.png`、首次 Action/receipt、snapshot 与准备/执行释放记录                            |
| RE-E04 精确文件编辑与第二次执行 | 同一任务出现文件编辑审批卡，核对只改已授权 `recipe.json`，真实点击一次“批准”。等待第二次远端调用，不手动同步                                                                            | localEdit=1；新 bytes/hash 与批准修改一致，新 snapshotId 不同；上传仍只有精确授权路径；第二次 CAD completed/passed，confirmed released；remoteTool=0、other=0，总审批=2                                                                    | `04-edit-pending.png`、`05-second-run.png`、两版 manifest/inputHashes、两组 Action/request/session ID |
| RE-E05 自动模式强制批准         | 独立聊天选“自动批准”，发送新任务并等批量卡；不点击时不得上传，真实批准后才可继续                                                                                                        | batch 仍显式出现；自动模式的其他编辑可能自动批准，**不沿用主链路总数2的断言**。单独记录模式与审批来源                                                                                                                                      | `06-auto-batch-pending.png`、approval mode/事件及实际上传时间                                         |
| RE-E06 拒绝                     | 独立任务到批量卡后点“拒绝”；另以独立任务在本地编辑卡点拒绝                                                                                                                              | 批量拒绝为零上传/零工程调用；编辑拒绝保持原 bytes，不得以未批准修改执行第二次调用；旧结果保留。记录 `approval-resolved.origin=user`（UI 的 `resolutionOrigin`），不把中断取消当主动拒绝                                                    | `07-rejected.png`、拒绝事件、前后 hash、实际调用计数                                                  |
| RE-E07 新增路径/工具            | 使用支持扩展场景的模型序列，在已批准任务中额外请求一个无秘密文件或实际可用的具名工具；观察新增完整批量卡并先拒绝，另轮再批准。另测下一用户任务重新授权                                  | 旧 grant 不自动扩大；新增路径/工具批准前不得上传/派发。新任务重新确认与同任务扩展分别记录；未知工具不能被当成已支持范围                                                                                                                    | `08-expanded-scope.png`、旧/新计划差异、approvalId、上传/调用清单                                     |
| RE-E08 真实成果显示             | 展开两次实际工具结果/成果，点击“打开”、文件和检查详情；从项目文件树打开本次导入的受支持 CAD/报告，必要时用“浏览远程产物”→“下载到项目”取指定文件                                         | UI 项目/chat/Action/Artifact 与 canonical、源 receipt、snapshot 逐一映射；对实际 bytes 验 size/SHA。UI 不得把 completed 或 Viewer ready 当 passed；旧版结果应仍可读。缺失应有成果卡/产物、错误绑定或伪造通过记 fail，不用历史 fixture 顶替 | `09-results-and-checks.png`、`10-real-artifact.png`、映射 JSON、下载 hash；不只截最终自然语言         |
| RE-E09 Viewer 只读与报告读取    | 在实际 CAD Viewer 点击缩放、Fit、全屏并 Esc 返回；用当前设备验证滚轮/捏合，未具备设备的子项注明 blocked。查看真实远端报告；Agent 最终回答包含两次实际 Action ID                         | 文件树→Registry→实际渲染成功；导航保留、源文件 hash 不变。报告读取必须有真实 Artifact ID/tool result；文本复述或模型 fixture 中硬编码报告不能替代                                                                                          | `11-viewer-fullscreen.png`、前后 hash、report read artifactId、最终答复与真实 ID 对照                 |
| RE-E10 重开与历史               | 正常关闭后重开同一应用配置，点击相同项目与聊天，展开已批准/拒绝记录与两次成果；再次打开真实文件                                                                                         | 历史审批不能重新点击，读取历史不新建远端工程调用、不上传、不重复占租约；TaskService `finished`、Action `completed`、Verifier 状态各自解释。下一任务有新任务授权，精确文件记忆不等于跨任务工具许可                                          | `12-reopened-history.png`、关闭/重开日志、调用计数、历史身份与hash                                    |
| RE-E11 停止与清理               | 独立受控用例点击“Stop agent”；已确认空闲且属于本验收的遗留会话才点“结束远程会话”。成功链路自动释放后正常退出/退出登录，关闭本次模型fixture                                              | Stop不等于远端取消；running/unknown/needsImport 不冒称 released，不重放。只清理本次资源，确认停止/释放及 Agent 子进程退出；留存工程与证据，不删他人会话                                                                                    | `13-cleanup.png`或真实已释放状态截图、release/termination、logout和进程清理记录                       |

现有 `remote-chat-model-fixture.cjs` 面向成功序列，不承诺拒绝后续聊或同任务扩展分支。使用它完成主链路时，负向场景需另一个明确记录的受控模型序列或真实模型；没有相应前提时将该子用例记 `blocked: model-fixture-scenario-unavailable`。不得改造远端响应、预写批准或把重启 fixture 后的新任务冒充原任务续行。

### 取证与 blocked 模板

至少保留上述窗口截图、每次用户点击对应 approvalId/decision/来源、初始及修改后文件 hash、完整不可变计划、每次 snapshot、远端 request/session、canonical Action/Artifact/Verification/Checkpoint 与 source receipt 的对应表。截图须来自本次实际应用窗口，记录时间与用例 ID；对敏感字段遮盖并注明脱敏，不使用生成图片或 headless 报告冒充界面。UI 未显示的 ID 可通过只读记录建立映射，不能修改记录以匹配截图。

按协议逐用例判定。缺图形桌面、Electron 未提供窗口、正式登录不可用、fixture 场景不足等写出具体阻塞；已经实际出现错误行为则记 fail。blocked 不自动传染其他前提齐备的层，但不能把该点击项换成 headless 后记 pass。主成功链路通过也不能替未执行的 reject、扩范围、重开或平台组合通过。

```json
{
  "module": "RE-electron-click",
  "commit": "<本次完整锚定SHA>",
  "workspaceStatus": "<dirty快照文件>",
  "platform": "<OS/arch>",
  "application": { "kind": "source-or-packaged", "electron": "<实际版本>", "kimi": "<实际版本>" },
  "modelService": "real-or-local-mock",
  "remoteService": "real-deployment",
  "status": "blocked",
  "cases": [
    {
      "id": "RE-E01",
      "status": "blocked",
      "reason": "electron-window-unavailable",
      "evidence": ["<本次probe报告>"]
    }
  ],
  "attempt": {
    "command": "<实际启动命令>",
    "startedAt": "<UTC>",
    "finishedAt": "<UTC>",
    "exitCode": null,
    "signal": "SIGABRT",
    "stderr": "<原文路径或明确为空>",
    "visibleHarnessWindow": false
  },
  "actualClickCount": 0,
  "notExecuted": [
    "RE-E02",
    "RE-E03",
    "RE-E04",
    "RE-E05",
    "RE-E06",
    "RE-E07",
    "RE-E08",
    "RE-E09",
    "RE-E10",
    "RE-E11"
  ],
  "headlessEvidence": "<独立共享链路证据，可关联但不替代>",
  "cleanup": "<实际清理或未创建资源>",
  "resumeRequires": "<正常可见Electron窗口及对应缺失前提>"
}
```

模板只展开一个 case；实际报告须为 RE-E01–RE-E11 逐项填写状态、原因与证据，不能仅给未执行列表。模板中的 signal/exitCode/窗口状态只是填写形状，复验必须写本次观察值；没有 stderr/堆栈就写空或缺失，不能从历史尝试补入。恢复环境后使用新证据目录从未通过的点击项开始，保留旧 blocked 记录。

## 自动覆盖缺口

main 的受控服务回归不是实际调度集群或生产 OIDC 授权验收。上面链接的真实部署 headless CAD 成功只覆盖其明确的账号、模型fixture、输入和执行路径；Electron 点击仍按本节单独验收。真实模型服务、其他领域与客户端平台须单独验证，没有部署、权限或可见窗口就逐用例 blocked。历史 macOS arm64→H200 chip RTL 路径不自动扩展为五域或 Windows/Linux 支持。

[返回矩阵](modules.md)
