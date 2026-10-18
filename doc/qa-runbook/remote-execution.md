# RE：远程执行

依据：[内置远程运行](../remote-execution.md)、[平台账号](../platform-account.md)、PD-079。官方远程配置仍为空；空配置正确提示是可以通过的产品用例，真实公网执行则应 blocked。不要把历史 H200 内网 RTL 证据当成生产账号已联通。先走[协议](protocol.md)，使用经授权的测试部署与专用工程。

## 自动命令

```sh
node --test packages/harness-core/tests/remote.test.cjs packages/harness-core/tests/account-remote.test.cjs apps/cli/tests/remote.test.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:ui
```

这些属于 T1/T2，覆盖受控 HTTP 服务、共享配置、固定身份、上传同意和事实校验，不需要真实生产凭据。真实平台配置与 Token 只能在宿主提供；不得写进日志、仓库或截图。

CLI 手工路径（将工程、领域、文件替换为专用验收输入）：

```sh
node apps/cli/src/main.cjs remote status
node apps/cli/src/main.cjs remote connect
node apps/cli/src/main.cjs remote use --project-dir /path/to/project --domain chip --location remote
node apps/cli/src/main.cjs remote sync --project-dir /path/to/project --domain chip --file eda.yaml --file rtl/counter.sv
```

最后一条只预览；审核目的地、项目、精确文件摘要后才对同一清单加 `--confirm-upload`。实际执行会运行专业任务，须有有效模型配置和该部署认可的 Pack/profile：

```sh
node apps/cli/src/main.cjs run --project-dir /path/to/project --domain chip --task '运行远程验证' --approval approve
node apps/cli/src/main.cjs remote task --project-dir /path/to/project --domain chip
node apps/cli/src/main.cjs remote cancel --project-dir /path/to/project --domain chip
```

## 手工矩阵

| ID | 步骤与预期 | 边界／失败恢复 | 必留证据 |
| --- | --- | --- | --- |
| RE-01 空配置 | 项目详情选择“知满远程（体验）”，保存后新聊天继承；尚未配置时显示原因，不能执行；切回本机可用 | 不自动填官方 URL 或上传工程；本机配置不等于远端机器/profile 选择器 | 当前配置状态、位置继承、失败提示 |
| RE-02 身份连接 | 配置授权的 HTTPS 部署，检查连接并固定 serverId/远端项目/subject；在任务运行时改变设置 | URL 禁凭据和重定向，非 loopback HTTP 拒绝；绑定变化不得把现有任务发往另一服务/账号 | 脱敏 origin、固定身份一致性、拒绝记录 |
| RE-03 上传同意 | 默认无选中，预览小文件清单后确认；确认后改 bytes、加删路径、等待超过五分钟分别再试 | 清单/目的地/摘要/过期变化须重审；>256 文件或 >8 MiB、越界/软硬链接/常见私钥凭据拒绝；不声称通用敏感识别 | 清单摘要与计数、同意时间、排除错误；不附秘密 |
| RE-04 正常任务 | UI 和 CLI 各用相同 Pack/profile/input 走准备→排队→运行→收集→结束，核对 canonical 事实和 CAS hash | 不要求日志/本地 run ID 字节相同；执行结束不等于 Verification passed；远端本地任务/MCP组合边界保持 | request/job/Action/Artifact/Verification/Checkpoint 关联、hash |
| RE-05 审批/Scope | 无 grant、拒绝审批、过期 scope 分别试，再批准合法工具 | 专业工具不走本地 fallback；凭据不进入 renderer/Agent 环境 | 拒绝/批准事件、实际执行次数、脱敏环境检查 |
| RE-06 断线恢复 | 提交后断开宿主/网络，重启按已落盘 request/job 查询；另试未知结果、篡改下载、过期 State | 不自动重放提交；查不到保持 unknown；大小/hash/事实绑定失败不导入通过；重连后保留旧历史但不认证新输入 | journal、提交次数、状态查询、未导入原因 |
| RE-07 取消与退出 | 对指定 request/job 取消并等待终态；登录退出或切换账号后查看既有任务 | cancel/完成不等于工程通过；退出不停止任务、不丢身份，换账号不迁移项目 | 目标任务 ID、终态、清理与恢复记录 |

## 自动覆盖缺口

main 的受控服务回归不是实际调度集群或生产 OIDC 授权验收。真实公网地址、生产模型/远程按服务 Token、其他领域与客户端平台须单独验证；没有部署或权限就逐用例 blocked。曾验证的 macOS arm64→H200 chip RTL 路径，不自动扩展为五域或 Windows/Linux 支持。

[返回矩阵](modules.md)
