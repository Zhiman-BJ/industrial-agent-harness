# 已部署服务的新流程验收尝试（2026-10-20）

客户端产品代码：`488c5726d3643a55b752f18003fa026e842aac20`（PR #230）。本次没有新的产品代码修改。

## 已确认的事实

- 现有测试部署处于 Running / Ready，部署镜像版本为 `test-ef86089`。
- 在现有测试网络内用 Node v24.22.0 正常访问配置的 HTTPS ingress：`/healthz` 返回 HTTP 200、`ready: true`。正常 OIDC discovery 也返回 HTTP 200。
- 本地执行进程访问相同 ingress 超时；账号服务 discovery 可达。这不能解释为远端服务未部署或未就绪。
- 官方 `scripts/package-headless.cjs --domain cad` 成功打包当前客户端代码，并装入本次独立的临时测试客户端。
- 独立测试客户端使用 non-root、RuntimeDefault、禁止提权、丢弃 Linux capabilities、只读根文件系统；未挂载服务账号 Token、业务 Secret 或用户工程。
- 该环境的用户命名空间探测失败：`unshare: unshare failed: Operation not permitted`。真实 Kimi 对话要求 bubblewrap 和可用的用户命名空间，因此本次环境无法执行正式对话 Agent。
- 本地使用正式 `createProcessSandbox` 包装 `/usr/bin/true` 的最小探测同样失败：退出码 71，`sandbox-exec: sandbox_apply: Operation not permitted`。没有启动 Electron 或模型；生成的临时目录已删除。
- 正常 AuthManager 的内存 PKCE 登录已生成授权链接；浏览器控制连接随后报告 `Transport closed`，重置连接同样失败。未完成登录，没有获得或持久化账号令牌。
- 本次独立临时 Pod 已删除，登录进程已随之取消；既有服务容器中只读探测创建的空临时目录也已删除。没有修改现有服务、权限或安全策略。

## 尚未通过的项目

本次**没有发出 CAD 工程调用，也没有上传测试快照**。下列项目仍需真实执行，不以健康检查、旧 CAD 证据、模拟测试或脚本语法检查代替：

1. 真实模型通过对话读取工程并选择文件与工具。
2. 一次远端批量授权完成准备。
3. 已批准文件变化后自动同步；同一任务不重复请求远端授权。
4. 两次远端 CAD 执行、独立产物哈希核验及会话自动释放。

`scripts/qualify-remote-chat.cjs` 提供可复用的真实 TaskService / KimiSession / AuthManager 验收入口。其合成任务期望一次远端批量授权及一次本地精确编辑授权，额外远端工具授权为零。此脚本的准备完成不代表上述流程已通过。

脚本的语法、ESLint、Prettier 和离线构造检查通过。执行前护栏的离线检查确认：错误输入、错误任务及第三次 CAD 调用在进入被委托的 Runtime 前拒绝。此检查只验证验收脚本的实验范围限制，不是模型、远端工程调用或新流程成功的证据。

恢复实测需要可正常登录、可访问测试 ingress、且支持正式 Agent 进程隔离的执行环境。当前 PR 保持 Draft。
