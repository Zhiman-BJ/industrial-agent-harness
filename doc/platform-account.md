# Obol 标准登录接入

日期：2026-10-14。开发基线：`22e930b`。客户端已实现，真实 Obol 手动登录链路已通过，用户已确认桌面 UI 登录成功。macOS CI 已通过真实回环协议和新版 Electron 界面回归。系统浏览器启动、生产回环路径的独立证据及打包安全存储仍待验收。

## 接入方式决策

直接调用 API 的用户自行在 Obol Console 创建项目 API Key；CLI / Desktop 登录 Obol 后直接使用用户 Access Token 调用模型 API，不要求或自动创建 Key。详见 [PD-078](product-decisions.md#pd-078直接-api-使用-key官方应用登录后使用用户-token)。

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
| 模型 API base URL | 明确绑定的可信模型服务地址，含服务要求的路径前缀 |
| 远程服务 origin | 明确绑定的可信服务；服务端仍须验证 JWT、权限和项目归属 |

当前已登记的 `harness-desktop` / `harness-desktop-1` 配置自动选择双授权：模型使用该客户端并按 RFC 8707 请求 `resource=https://api.zhiman.cn`，得到 `aud=obol-api`；远程 MCP 使用 `industrial-mcp-remote` / `industrial-agent-harness`。客户端标识公开但仍沿用部署配置，不改变自定义单应用部署。内部两个 AuthManager 独立持久化、锁定和刷新；界面仅一个账号，必须两份授权的 subject 相同才能使用。登录第二份授权失败会撤销第一份，统一退出等待迟到的兑换/刷新并撤销两份凭据。CLI 的同一个输入通道支持顺序两次粘贴。

模型配置使用 `https://api.zhiman.cn/v1` 和 OpenAI 协议；远程地址尚未确定时留空，不发送任何 MCP 请求。若选择 Anthropic 协议，上游前缀使用 Obol 的 `/anthropic/v1`。模型名称在原有模型设置中选择，不随账号授权变更。

Obol 主分支 `5a05c75` 已实现资源 Token 与模型网关支持，客户端直接适配已合入接口，不另加模型权限清单或网关开关。模型 Token 的 audience 固定为内置 `obol-api`；第一次调用模型时平台开通个人计费账户，按注册账户默认项目扣费。平台内部建立没有可用 prefix/hash 的登录计费会话，它不是用户 API Key。旧版本机模型登录会话会在锁内刷新成资源 Token，退出仍撤销原家族。明确的 `invalid_target` 保留凭据，仅拒绝对应服务请求。详见 Obol [接入说明](https://github.com/zhimanai/obol/blob/main/docs/account-api-access.md)。

远程服务补丁基于 v1.1 会话运行时分支，增加 Obol JWT 验签与权限检查；其前置 [PR #14](https://github.com/zhimanai/industrial-harness-remote/pull/14) 和客户端 v1 适配仍需单独合并/部署。按用户要求，本轮不连接真实远程 MCP。

本轮针对 Obol 主分支 `5a05c75` 的本地跨仓验收已通过：实际 Harness 双授权协调器 → 实际 Obol OIDC → 模型代理 → 模型网关 → PostgreSQL 账本，Redis 参与限流，推理使用可控测试后端。覆盖模型调用、独立刷新轮换、统一退出后模型访问立即失效，并确认没有创建用户 API Key。本轮只适配 Harness 和远程服务，不修改或部署 Obol；该证据不是生产推理或线上部署验收。

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
| 模型 API / 远程服务账号鉴权 | 本地跨仓模型链路及远程 HTTP/MCP 验签通过；生产模型待确认新版网关部署并实测，真实远程联通按用户要求延期。 |

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
