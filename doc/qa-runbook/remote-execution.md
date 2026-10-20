# RE：远程执行

本机 Agent 按 [PD-088](../local-agent-execution.md) 在三平台使用当前用户权限；远端验收不再以本机 Seatbelt/bubblewrap 为聊天启动前提。远端认证、租户/项目隔离、软件资格、快照与产物校验及沙箱释放仍是独立必验项，浏览器健康响应或本机启动成功均不能替代完整链路。

依据：[内置远程运行](../remote-execution.md)、[平台账号](../platform-account.md)、PD-079 与 [PD-087](../product-decisions.md#pd-087远程任务在对话中规划与批量准备)。官方远程配置仍为空；空配置时聊天及本地工程规划可用、真正的远程执行被阻止是可以通过的产品用例。不要把历史 H200 内网 RTL 证据当成生产账号已联通。先走[协议](protocol.md)，使用经授权的测试部署与专用工程。

## 自动命令

```sh
node --test packages/harness-core/tests/remote.test.cjs packages/harness-core/tests/account-remote.test.cjs apps/cli/tests/remote.test.cjs
node --test packages/harness-core/tests/remote-preparation.test.cjs packages/harness-core/tests/current-remote-runtime.test.cjs packages/agent-kimi/tests/approval.test.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:ui
```

这些属于 T1/T2，覆盖受控 HTTP 服务、共享配置、固定身份、上传同意和事实校验，不需要真实生产凭据。真实平台配置与 Token 只能在宿主提供；不得写进日志、仓库或截图。

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

| ID                  | 步骤与预期                                                                                                                                                                                             | 边界／失败恢复                                                                                                                                              | 必留证据                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| RE-01 聊天优先      | 项目详情选择“知满远程（体验）”，保存后项目详情与侧栏均可进入聊天，重启后复用已有空白聊天；在本地模型/Agent 可用时，远端未配置、离线、未同步或查询失败仍可发送并本地读写工程                            | 执行状态如实显示阻塞原因，真正远程工具调用被阻止；不自动填官方 URL 或上传整个工程；无项目、领域或本地 Agent 不可用的原有条件保留                            | 聊天输入和发送状态、本地读写结果、远端调用/上传次数                                |
| RE-02 身份连接      | 配置授权的 HTTPS 部署，检查连接并固定 serverId/远端项目/subject；在任务运行时改变设置                                                                                                                  | URL 禁凭据和重定向，非 loopback HTTP 拒绝；绑定变化不得把现有任务发往另一服务/账号                                                                          | 脱敏 origin、固定身份一致性、拒绝记录                                              |
| RE-03 对话计划/准备 | Agent 先阅读工程，再用 `project.remote.plan` 选择任务文件和具名工具；计划不上传。`project.remote.prepare` 展示固定路径、大小、hash、目的地、工具及记住选项，显式批准一次后上传；自动审批模式重复此用例 | 拒绝不上传；批准前改 bytes/目的地/绑定或等待五分钟使计划失效。空清单、>256 文件或 >8 MiB、越界/软硬链接/常见私钥凭据拒绝；不声称领域依赖解析或通用敏感识别  | 不可变审核摘要、批量审批事件、上传次数、拒绝原因；不附秘密                         |
| RE-04 正常任务      | UI 和内部 CLI 各用相同 Pack/profile/input 走准备→实时发现→调用→收集→结束，核对 canonical 事实和 CAS hash                                                                                               | 静态目录/profile 清单不代表执行就绪，受保护的实时描述失败则不调用；执行结束不等于 Verification passed；当前 MCP 回执由本地规范记录包装，不伪造服务端事实    | invocation、远端 receipt 与本地 Action/Artifact/Verification/Checkpoint 关联、hash |
| RE-05 任务工具范围  | 批准一批工具后，同一任务的范围内工具无需重复审批；新增工具、新任务、拒绝审批、过期 scope、直接绕过准备分别尝试                                                                                         | 执行边界仍检查项目/领域/身份/任务/Tool ID，不能把一次准备视为全局许可；专业工具不走本地 fallback；凭据不进入 renderer/Agent 环境                            | 一次批量批准、范围内执行次数、越界拒绝、脱敏环境检查                               |
| RE-06 断线恢复      | 提交后断开宿主/网络，重启查看持久调用状态；另试未知结果、待导入、篡改下载、过期 State                                                                                                                  | 支持查询的协议按 invocation ID 查询；当前 MCP 无调用状态端点时保持 unknown，禁止自动重放、重绑、自动同步或另路重做；大小/hash/事实绑定失败不导入通过        | journal、实际提交次数、协议查询能力、未导入原因                                    |
| RE-07 停止与退出    | 中断本地等待，查询会话；空闲时显式结束，并检查服务确认状态。登录退出/切换账号后查看既有任务                                                                                                            | 停止等待不表示远端取消；busy/unknown/待导入不得冒充已释放；退出不停止任务、不丢身份，换账号不迁移项目                                                       | invocation/session ID、服务终态、清理与恢复记录                                    |
| RE-08 记住精确文件  | 默认启用记住并批准后，修改已批准路径，再调用远程工具；应自动同步新内容且不再询问同组文件。重启后重复；关闭记住选项后重复                                                                               | 新建或额外引用文件不自动上传，新增路径或工具需一次新的批量确认；目的地/身份变化及未知调用阻止自动同步。关闭记住时，内容变化要求新计划；快照仍按新 hash 冻结 | 批准与同步策略、每次 manifest/hash、实际上传路径、重启后结果                       |
| RE-09 手工高级入口  | 从项目执行设置手动选文件、审核并上传；对照聊天准备的目的地和文件边界；另测重绑及产物下载                                                                                                               | 手工上传不自动授予任务工具范围，也不默认授权后续内容同步；下载不覆盖已有源码；入口可选，不能成为聊天前置条件                                                | 手工审核、上传策略、下载目标及摘要                                                 |

## 自动覆盖缺口

main 的受控服务回归不是实际调度集群或生产 OIDC 授权验收。真实公网地址、生产模型/远程按服务 Token、其他领域与客户端平台须单独验证；没有部署或权限就逐用例 blocked。曾验证的 macOS arm64→H200 chip RTL 路径，不自动扩展为五域或 Windows/Linux 支持。

[返回矩阵](modules.md)
