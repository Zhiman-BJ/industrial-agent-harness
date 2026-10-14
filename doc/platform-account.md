# Obol 标准登录接入

日期：2026-10-14。开发基线：`22e930b`。客户端代码已实现；真实 Obol、操作系统回环端口和打包后的钥匙串验收尚未完成。

## 接入依据

已通过本机登录的 Chrome 核对 [Obol 账号接入指南](https://github.com/zhimanai/obol/blob/main/docs/account-integration.md)，页面文档最近提交为 `a93bc061767c2929585819f379c033139ff74fed`。按文档要求使用成熟 OIDC 库、Discovery、native/public client、Authorization Code + PKCE S256、随机 state、`openid profile offline_access` 和 Refresh Token 轮换。额外发送 nonce 并验证 ID Token 签名、issuer、audience、nonce 和有效期。

账号协议和会话由 `packages/harness-auth` 统一管理；Desktop 负责系统浏览器、safeStorage、主窗口 IPC 和界面；CLI 负责参数、JSONL、系统浏览器启动入口。Domain Packs、Kimi 原生 loop 和工业事实契约不承担账号职责。

## 已实现路径

1. 设置 → 平台账号 → 配置平台连接 → 在系统浏览器登录。回调只监听 `127.0.0.1` 临时端口，校验 state 后兑换授权码，完成/取消/超时关闭监听。
2. Desktop 凭证经系统安全存储加密落盘；Linux `basic_text` 或安全存储不可用时仅在内存保存。界面明确显示当前保存方式。安全存储异常不阻塞本地工作台。
3. 请求前按需刷新；多调用者/多进程共享文件锁，锁内重新读取凭证，原子保存轮换结果。刷新意图先落盘，进程崩溃或网络结果不明时要求重新登录，避免旧 Refresh Token 被再次消费。
4. 退出尝试撤销 Refresh Token 并清理本机凭证；撤销失败显示提示。退出不关闭远程任务，不清除任务 requestId/jobId，也不清除系统浏览器全局 SSO。
5. Remote Client 从 `credentialProvider` 按请求取凭证。只有读取请求遇到明确 `invalid_token` challenge 自动刷新后重试一次。变更请求沿用原有幂等日志，不自动重放；403 不触发刷新。
6. 云端模型采用随机本机 key + 固定上游代理，支持固定 `/v1/chat/completions`、`/v1/messages`、`/v1/models` 路由，保留流式返回。Kimi 子进程只接触本机代理 key；真实平台 Token 由可信代理获取和验证。
7. 账号 subject 纳入远程绑定身份；已有 Remote Client 固定创建时的 subject。切换账号不自动迁移旧项目和任务。

详细配置、CLI 命令和公开说明见 [harness-auth README](../packages/harness-auth/README.md)。

## 平台部署必须提供的内容

| 配置 | 约束 |
| --- | --- |
| Issuer | 默认生产 `https://auth.zhiman.cn`；可配置 dev/local |
| Native client ID | 必须真实注册且开启本机回调；不能使用应用 slug 代替 |
| Application audience | 模型/远程服务实际接受的应用 slug |
| 模型 API base URL | 明确绑定的可信模型服务地址，含服务要求的路径前缀 |
| 远程服务 origin | 明确绑定的可信服务；服务端仍须验证 JWT、权限和项目归属 |

当前版本一份账号配置绑定一个应用 audience。模型 API 和远程服务必须同属此授权应用；如果两者属于不同应用，需要分别注册/授权，不能将一个 Token 当作跨 audience 的万能凭证。未实现 Token Exchange，不推断 Obol 已支持此协议。

尚未取得 Harness 的正式 client ID、应用 slug 或受信业务 endpoint，也未修改 Obol 应用注册、角色清单或远程服务端鉴权。本次不提供组织切换/额度 UI，因为已读文档没有给出对应客户端契约。

## 验证与边界

- 实际 `openid-client` + `jose` 的签名 OIDC 测试覆盖正确授权、错误 state/nonce/audience/签名、轮换、并发、刷新中断、取消后迟到回调、刷新途中退出撤销最新 Token 和模型流式转发。
- 独立测试覆盖安全存储适配器、0600 权限、符号链接、IPC 主框架绑定、远程 GET 的受限重试和切换账号后拒绝旧客户端。
- `account-selftest` 已添加真实 Electron 主窗口 → preload → 账号模块 → 本机测试 OIDC 服务 → 界面状态 → 刷新 → 退出的入口。
- 本次环境拒绝 `listen 127.0.0.1`（EPERM），真实端口测试无法运行。协议测试使用显式 `AUTH_TEST_TRANSPORT=memory`；这不代表系统浏览器、OS 回调或打包钥匙串已验收。
- TypeScript 检查与 Vite 生产构建通过；架构契约检查与 edition 清单检查通过。完整架构套件 47/48 通过；`candidate-fetch` 大对象测试发生 `git ENOBUFS`，在已有未修改分支可复现，不修改此检查或扩大任何架构例外。相关文件 ESLint 无错误，保留四项异常 cause 提示（账号错误不传播原始凭据解密/解析异常）。
- 网络无法解析 GitHub/npm，完整 pnpm 在线供应链校验未完成。开发验证使用本机既有依赖缓存，新增库 tarball 已按锁文件的官方 SHA-512 校验；标准安装仍需在具备网络的 CI 环境补跑。

交付前在正常开发机/CI 执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @industrial-agent-harness/harness-auth test
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:account
pnpm test:architecture-contract
pnpm test:architecture
```

本次环境下相关回归共 39 项通过（账号、存储、IPC、CLI、远程绑定、模型配置与语言），可用以下命令重跑：

```sh
AUTH_TEST_TRANSPORT=memory node --test packages/harness-auth/tests/*.test.cjs \
  apps/desktop/electron/account.test.cjs apps/cli/tests/account.test.cjs \
  packages/harness-core/tests/account-remote.test.cjs \
  apps/desktop/electron/model-config.test.cjs apps/desktop/electron/language.test.cjs \
  apps/cli/tests/args.test.cjs
```

随后使用已登记的真实 Obol native client 登录，验证模型与远程服务实际 audience/permissions、过期恢复、注销和原账号任务恢复。通过前不要宣称生产联调或三平台打包支持完成。
