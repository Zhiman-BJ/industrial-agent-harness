# Obol 标准登录接入

日期：2026-10-14。开发基线：`22e930b`。客户端已实现，真实 Obol 手动登录链路已通过，用户已确认桌面 UI 登录成功。macOS CI 已通过真实回环协议和新版 Electron 界面回归。系统浏览器启动、生产回环路径的独立证据及打包安全存储仍待验收。

## 接入依据

已通过本机登录的 Chrome 核对 [Obol 账号接入指南](https://github.com/zhimanai/obol/blob/main/docs/account-integration.md)，页面文档最近提交为 `a93bc061767c2929585819f379c033139ff74fed`。按文档要求使用成熟 OIDC 库、Discovery、native/public client、Authorization Code + PKCE S256、随机 state、`openid profile offline_access` 和 Refresh Token 轮换。额外发送 nonce 并验证 ID Token 签名、issuer、audience、nonce 和有效期。

账号协议和会话由 `packages/harness-auth` 统一管理；Desktop 负责系统浏览器、safeStorage、主窗口 IPC 和界面；CLI 负责参数、JSONL、系统浏览器启动入口。Domain Packs、Kimi 原生 loop 和工业事实契约不承担账号职责。

## 已实现路径

1. 设置 → 平台账号 → 配置平台连接 → 在系统浏览器登录。回调只监听 `127.0.0.1` 临时端口。同步支持文档规定的 `/oauth/code` → `code#state` 粘贴路径；二者共用 PKCE/state/nonce、按各自 redirect URI 兑换，先完成的生效。错误粘贴不消费待登录状态；取消/超时/退出阻止迟到结果重新登录。桌面提供可选中复制的登录链接与密码式授权码输入；CLI 的 `--no-browser`、SSH 和无显示环境使用纯粘贴流程，TTY 输入不回显。浏览器启动失败或卡住不阻塞粘贴、取消或超时；监听不可用时降级到粘贴。
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
| 模型 API base URL | Obol 模型 API，含 `/v1`；生产 `https://api.zhiman.cn/v1` |
| 远程服务 origin | 明确绑定的可信服务；服务端仍须验证 JWT、权限和项目归属 |
| 远程服务 audience | 远程服务在账号中心的应用 slug；服务要在权限清单里登记 `resource` 为上面的 origin |

一次登录可以访问多个服务（Obol [ADR 0007](https://github.com/zhimanai/obol/blob/main/docs/adr/0007-gateway-accepts-account-tokens.md)，已在 Obol 实现）。客户端用同一个 Refresh Token、以服务地址作为 RFC 8707 `resource` 分别刷新，每个服务拿到只属于自己的 Token：模型 API 的 audience 固定为 Obol 内置应用 `obol-api`，远程服务的 audience 单独配置（`remoteAudience`）。Token 按服务缓存在会话里，使用前按该服务的 audience 验签。用户在某个服务没有授权时，Obol 返回 `invalid_target` 且不轮换 Refresh Token：客户端只提示“该账号无权使用此服务”，登录保持有效，其他服务不受影响。

模型调用：Obol 网关直接接受 `obol-api` Token，费用记在登录用户自己的 Obol 账户（首次调用自动开户并获得注册赠送）。模型代理遇到 401 会刷新后重试一次；402/403/429 转为简短说明交给 Kimi，不透传上游响应。远程服务仍使用预配置 Bearer 凭据，等服务端支持验证账号 Token 后再切换。

已在 Obol 运营台核对用户登记的 native client `harness-desktop-1`，所属应用为 `harness-desktop`，本机回调已开启；用户确认已解决应用授权要求。client ID 是应用标识，不是个人凭据，仍由部署配置提供，不写成公共客户端的默认值。模型与远程服务的账号鉴权尚未联调；组织切换、额度接口不在本次范围。

## 验证记录（2026-10-14）

| 范围 | 结果与证据 |
| --- | --- |
| 真实 Obol 手动登录 | 隔离验收入口的本机报告通过：登录、强制刷新、Refresh Token 轮换、刷新后 UserInfo subject 一致、撤销、凭据与临时目录清理全部通过。报告不包含身份或 Token。 |
| 真实 Desktop UI 登录 | 用户于 14:17（Asia/Shanghai）确认登录成功，并提供已登录界面截图。属于修改界面样式前的用户验收，不推断实际采用的回调方式。 |
| 受控账号与适配器回归 | 58/58 通过：真实 OIDC/JWT 库，显式内存 HTTP 传输，覆盖 Desktop IPC、CLI、账号存储、远程绑定、模型配置与语言。 |
| 界面整理 | 统一中性深浅色、紧凑账号信息、连接参数折叠和固定底部操作。TypeScript、生产构建、相关 ESLint、格式检查通过。 |
| 新版原生界面回归 | [PR #151 首轮账号 CI](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/38524395997) 的 macOS 15 检查已通过真实 Electron 登录、取消、错误/正确粘贴、刷新、退出和深浅色/640×480 布局，并上传截图。本机自动化环境仍在 Electron 初始化阶段 SIGABRT。 |
| Windows 首轮 CI | 登录协议通过，软链接拒绝测试失败；Windows 不提供 O_NOFOLLOW。已补齐读取前 lstat 检查和打开后的文件身份比对，保留软链接测试并增加文件替换竞态回归；后续平台结果见 PR 检查。 |
| 打包后的安全存储、Windows ACL | 待验收；受控加密适配器通过不能替代真实钥匙串或安装包验证。 |
| 按服务换取 Token | 受控 issuer 回归通过：按 resource 刷新并保存轮换后的 Refresh Token、按服务缓存、到期和被拒后刷新、无权服务不退出登录、audience 不符拒绝转发、模型代理 401 重试一次与 402/403 说明。 |
| 模型 API 账号鉴权（生产） | 待用本机 harness + 生产 Obol 手动验收。 |
| 远程服务账号鉴权 | 未验收；远程服务尚未验证账号 Token。 |

共享协议测试包含错误 state/nonce/ID Token audience/签名、Access Token audience、刷新轮换与并发、崩溃标记、取消后迟到回调、刷新途中退出撤销最新凭据、模型流式转发和错误脱敏。Desktop IPC 只接受主窗口主 frame，渲染器不能读取 Token。

本机此前 Discovery 的 DNS 失败以及自动浏览器流程超时是各次执行环境的诊断结果。随后普通终端中的生产手动验证与用户桌面登录已经通过，不再把早期网络问题作为当前接入失败结论。Discovery 原始文档包含 S256。

### 可复现的生产验收入口

从能访问账号平台的普通交互终端运行：

```sh
node scripts/verify-obol-login.cjs \
  --client-id harness-desktop-1 \
  --audience harness-desktop \
  --no-browser \
  --report /tmp/harness-obol-manual-result-new.json
```

打开终端输出的授权链接，完成账号验证，再将完整 code#state 粘贴到同一终端。输入不回显；不要通过聊天、日志或命令参数传递授权码。删除 --no-browser 可验证自动打开浏览器和本机回调，不能把手动模式通过等同于该路径通过。

入口复用 AuthManager，在独立临时目录中仅以内存保管凭据，不读取个人配置；验证完成后撤销测试会话并清理。报告仅记录脱敏阶段、布尔检查与错误码，报告路径必须不存在。该入口不覆盖 Electron UI、系统钥匙串或业务服务。

### 自动回归与 CI

```sh
AUTH_TEST_TRANSPORT=memory node --test packages/harness-auth/tests/*.test.cjs \
  apps/desktop/electron/account.test.cjs apps/cli/tests/account.test.cjs \
  packages/harness-core/tests/account-remote.test.cjs \
  apps/desktop/electron/model-config.test.cjs apps/desktop/electron/language.test.cjs \
  apps/cli/tests/args.test.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm test:architecture-contract
pnpm test:architecture
```

普通开发机/CI 另执行 pnpm install --frozen-lockfile，并在未设置 AUTH_TEST_TRANSPORT 的情况下运行账号包测试，再运行 pnpm --filter @industrial-agent-harness/desktop test:account。内存传输用于受限环境下的协议回归，不能证明真实端口可用。

.github/workflows/account-login.yml 在 macOS 15 和 Windows 2025 执行固定依赖安装、真实 loopback socket 协议回归、桌面构建和 Electron 账号自测，并上传日志和界面截图。CI 使用本地受控签名服务，不需要生产手机号、短信验证码或平台凭据。Electron 自测通过注入的浏览器 opener 完成授权，不能证明 OS 系统浏览器启动成功。该工作流作为独立 PR 检查展示，未修改分支保护或 CI 聚合规则。
