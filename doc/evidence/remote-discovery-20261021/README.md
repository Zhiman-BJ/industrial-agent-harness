# MCP 产品 1.3.1 连接回归

日期：2026-10-21。基线为 `e114016f51665a1ec741f2025eec3c18ec9adce4`（PR #243 合并后，也是 `desktop-v1.0.1-beta.7` 发布标签）。本修复尚未包含在该已发布包中。

## 原因与真实部署验证

真实 `/v1/service-info` 返回 HTTP 200，包含 `version: "1.3.1"`、五个领域目录、合法 `capabilitySnapshotHash`、`sessionModel: "application-session"`。服务实现见 `zhimanai/industrial-mcp-remote` 提交 `5559624` 的 `apps/http.cjs`；发现接口未声明 canonical `remoteProtocolVersion`。

基线兼容路径的产品版本正则仅接受 `1.1.x` 和 `1.2.x`，因此完整合法的 `1.3.1` 响应仍落入通用“remote execution protocol 1.1”错误。最初的 `ff95b2e` 修复增加稳定 `1.3.x`；后续根据服务端保持兼容的约定，进一步移除产品版本白名单。当前代码按发现响应结构识别 MCP v1，产品 `version` 不再决定兼容性；显式协议、执行资格、实时工具发现与上传审批仍分别校验。

[connection.json](connection.json) 记录同一现有桌面账号、同一真实部署的生产 `RemoteSettings.check()` 前后对照。每次只有一个 `GET /v1/service-info`；不记录令牌和账号身份，不创建远程工程、不上传文件、不调用专业软件。

真实 Electron 源码候选（Electron 44.0.0、macOS arm64）构建后，通过 CUA 原生界面打开“设置 → MCP 与技能”，实际点击“检查连接”；观察按钮从“正在连接…”恢复为“检查连接”，服务卡片保持“已连接”。这是当前真实部署的 UI 检查，不是 fixture 截图，也不证明完整远端工程任务已通过。

## 验收缺口与补充

- 既有单测明确将 `1.3.0` 作为应拒绝输入，CI 因而固化了过时产品范围。
- 原生验收没有运行 Remote 连接 UI；原 `remote-ui-selftest` 需要事先存在的远端 artifact，且 fixture 提供 canonical envelope，无法覆盖本次产品兼容分支。
- 新 `test:remote-connection` 自备隔离的只读 loopback fixture；当前七个场景覆盖 canonical、1.3.1、未来 1.4/2.0 成功、显式协议不兼容、无效 hash 和恢复。现有 `test:mcp` 保留原完整测试并追加该检查，已有 macOS CI 的 MCP 入口会运行它；没有修改 workflow 或 architecture policy。
- 发版还须执行 QA runbook 中的当前候选、真实账号、真实部署连接检查；CI 的 fixture 不能替代它。完整 RE-E01–11 的未通过用例继续保留原状态。

## 本机回归

[validation.json](validation.json) 记录最初 `ff95b2e` macOS arm64 源码候选的检查结果：远端相关 168/168、架构契约 20/20 通过；完整 portable 1091 通过、8 个既有平台允许 skip、0 失败。Desktop build、ESLint、Prettier 通过。该记录早于移除产品白名单的修改，不能替代当前候选的回归结果。其他平台的托管原生结果须以本 PR 的 CI 为准。

最初 `ff95b2e` 的 Electron 44.0.0 连接 smoke 已实跑：当时五个场景全部通过，退出码 0，断言总计五次 `GET /v1/service-info`；使用独立的临时 userData/account/resources。该历史结果与前述真实部署的认证连接及原生 CUA 点击分别记录，不相互替代，也不代表当前七场景 smoke 已通过。

## 移除产品白名单的回归

后续修改基于 #244 合并提交 `1415475`。远端相关回归 190/190、架构契约 20/20、变更代码 ESLint 与格式检查通过。产品升级回归同时验证已有工程绑定、服务身份与 `mcp-v1` 适配器不变；缺失或非标准产品版本不能代替结构、显式协议及执行权限校验。

受限本机环境的完整 portable 结果为 1078 通过、13 失败、8 个允许的平台 skip，不能记为通过。失败集中在默认资源/日志目录写入权限、隔离启动、Unix socket 与 DMG 挂载能力；与本次专门的远端回归结果分别记录。七场景原生连接 smoke 在 Electron 启动前被 macOS GUI 服务访问检查阻止（bootstrap 1100，exit 1），尚未执行。当前候选的完整托管 CI 与原生验收须查看后续 PR 的对应提交结果，不能沿用 `ff95b2e` 的通过记录。
