# MA：模型配置与平台账号

依据：[模型 API](../model-api-compatibility.md)、[平台账号](../platform-account.md)、PD-074–079。账号登录可选，本地工作台不强制登录；模型与远程权限分别判断。先遵守[协议](protocol.md)，不可在命令、截图、报告里带真实 Key、Token、授权码或刷新凭据。

## 自动命令

```sh
node --test packages/harness-auth/tests/*.test.cjs apps/cli/tests/account.test.cjs apps/desktop/electron/account.test.cjs packages/harness-core/tests/account-remote.test.cjs apps/desktop/electron/model-config.test.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:model-sync
pnpm --filter @industrial-agent-harness/desktop test:account
pnpm --filter @industrial-agent-harness/desktop test:gui-settings
```

T1 自动发现协议/配置单测。独立 `account-login.yml` 在 macOS 15/Windows 2025 跑真实回环 socket + 签名受控 OIDC 和 Electron account；model-sync 在 industrial-core 的 full 路径执行。受限环境可按平台账号文档使用 `AUTH_TEST_TRANSPORT=memory` 定位，但内存通过不能覆盖真实端口失败，更不能替代 workflow。

## 手工矩阵

| ID | 步骤与预期 | 边界／失败恢复 | 必留证据 |
| --- | --- | --- | --- |
| MA-01 模型配置 | 隔离配置中设置协议/可信 base URL/模型/上下文/思考；保存后不刷新即同步当前渲染端，外部 IPC 保存也同步；切换项目 | 仅表单通过不等于 API 成功；无效配置明确提示，Key 不出现在摘要或诊断正文 | 脱敏配置、广播前后状态、错误码 |
| MA-02 两种登录 | 系统浏览器+loopback 与 no-browser 粘贴分别验收；复制链接，输错 code#state 后可重输，取消/超时后迟到响应不能登录 | 两条路径只能一条成功换码；浏览器打不开仍可粘贴/取消；不能在聊天传授权码 | 路径名、脱敏阶段结果、取消/超时记录 |
| MA-03 单登录按服务 | 登录一次先用模型，再触发配置好的远程凭据读取；无远程权限时模型/登录仍可用；无重复授权 UI | 每个 Token 只有一个 audience；invalid_target 仅影响对应服务，invalid_grant/未知刷新要求重登；不代建 API Key | 服务类别、布尔检查、错误码，不记录 Token |
| MA-04 重试与退出 | 受控服务注入 invalid_token、普通 401、403/429、连接中断；刷新中退出，再启动检查状态 | 只有明确 invalid_token 才刷新重试一次；网络不明不重放生成/变更；退出等待在途轮换并撤销最新会话，失败如实提示；不停止远程任务 | 请求次数、服务错误类型、退出与缓存清理结果 |
| MA-05 存储与 UI | 打包应用登录，重启确认安全存储；深浅色/640×480 查看账号、服务地址、折叠连接区和固定底部；检查 Tab/Esc | Linux basic_text 或加密不可用只能内存，界面如实说明；CLI 明文持久化需显式选择；失败不阻塞本地工作 | 平台/包 SHA、实际存储后端、重启前后与脱敏截图 |
| MA-06 账号切换 | 账号 A 绑定远程项目，退出换 B，再查看旧项目/任务 | 不自动迁移 subject 或重定向旧任务；SSO 浏览器全局会话不等于应用已退出 | 绑定拒绝、任务身份与脱敏 subject 一致性结论 |

生产登录的独立复现入口（普通交互终端，报告路径必须不存在）：

```sh
node scripts/verify-obol-login.cjs --client-id harness-desktop-1 --audience harness-desktop --no-browser --report /tmp/harness-obol-qa-new.json
```

去掉 `--no-browser` 才验自动浏览器与回调；该脚本不覆盖桌面 UI、钥匙串或业务服务。它只临时保管测试凭据，完成后撤销并清理；不应把生产流程自动当成每次离线 QA 的门禁。

## 自动覆盖缺口

账号 CI 的 browser opener 是注入实现，不能证明 OS 浏览器启动。生产模型、真实远程服务、打包钥匙串/Windows ACL 仍需独立实测；本地受控跨服务测试不能扩大这几项声明。真实登录历史证据属于当时版本，不能替代本次产品包验收。

[返回矩阵](modules.md)
