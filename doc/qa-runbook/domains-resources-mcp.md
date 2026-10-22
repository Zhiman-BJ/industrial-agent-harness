# DR：领域安装、资源与 MCP

依据：[安装体验](../install-experience.md)、[容器镜像安装](../container-image-installation.md)、[领域工具资源](../domain-tool-resources.md)、[外部 MCP](../external-mcp.md)。Pack 源归 owner，本仓库只验固定发布物消费，不修改冻结源码。先走[协议](protocol.md)，使用独立配置、Pack store、项目及全新证据目录。

## 自动命令

```sh
pnpm test:release
pnpm --filter @industrial-agent-harness/pack-manager test
pnpm --filter @industrial-agent-harness/domain-mcp test
node --test packages/harness-core/tests/resource-settings.test.cjs packages/harness-application/tests/task-service.test.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:mcp
pnpm --filter @industrial-agent-harness/desktop test:external-mcp
pnpm --filter @industrial-agent-harness/desktop test:logs
node apps/desktop/scripts/test-install-experience.cjs
```

安装体验 driver 包含正常退出清理，quit 模式仅 macOS。T3 transport 要先准备固定 chip/pcb Python 环境，再持锁执行 `pnpm test:ci -- transport`。T4 native-installed 用独立生产 Desktop 和官方归档验新安装；T5 验打包 first-run/domains/CAD。安装 UI fixture 成功不等于真实软件下载或工程就绪。

Docker Linux engine 就绪后，可另跑真实 release 链路（有大文件下载，目录必须全新）：

```sh
node scripts/verify-release-image-installation.cjs dist/ci-reports/release-image-qa-new
```

在桌面能力中心使用既有受信签名目录执行安装、更新、修复和卸载；记录实际发布物身份与就绪状态。不能用开发者 acquire-container-image 的锁覆盖当作正式安装通过。

## 手工矩阵

| ID             | 步骤与预期                                                                                                       | 边界／失败恢复                                                                                                           | 必留证据                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| DR-01 首装目录 | 全新 profile 展示五域，检查当前平台可安装项、CUDA 实际限制、下载/空间估计；目录不可达时兼容 bundled 项仍可选     | 没发布或平台未资格不能假装 ready；模型连接、Pack 已装和工具就绪分别显示                                                  | 平台、目录/Pack 版本摘要、首屏及断网提示                      |
| DR-02 原生准备 | 选多个可用域，观察检查空间/下载/校验/解包/版本/激活；成功后运行声明的真实任务                                    | 缺磁盘、错误 hash、取消、关闭、进程中断后重开，journal 与失败状态可见；完成域保留，失败域可重试；不覆盖用户已有应用      | 锁/归档 hash、receipt、journal、真实 Verifications            |
| DR-03 镜像安装 | 有 Linux engine 时冷装，核对 bytes/SHA/OCI manifest/config/platform、load/tag/live identity；修复后卸载重装复用  | 无 docker、engine 不可达、非 Linux engine 在下载/激活前失败；取消无临时 tar；更新失败保留旧 Pack；卸载不删除 Docker 镜像 | 冷下载/复用标签、Docker 版本/身份、失败 receipt、临时文件检查 |
| DR-04 维护并发 | 能力中心补装/更新/修复/卸载；并发共享安装请求，桌面观察进度；损坏真实可执行文件后修复                               | 安装锁串行，其他进程进度可见但取消归持有者；正常版本检查不降级；项目领域绑定不随卸载自动迁移                             | 前后版本、锁归属、修复执行与重启状态                          |
| DR-05 工具目录 | 项目详情只看当前领域+外部 MCP，全局看已加载提供方；展开名称/ID/用途/版本/数量并搜索；试空目录/零工具/无结果/失败 | 实际 Runtime 注册与独立 MCP 清单分开；数字不能抄旧文档常数；提供方失败不泄漏环境或隐藏其他域                             | 实际 Pack pin、工具目录、搜索/错误截图                        |
| DR-06 资源策略 | 全局禁用提供方，项目依次继承/启用/禁用；查看 Broker scope，再通过真正执行入口尝试工具；切换项目/快速保存         | 三态一致，禁用必须执行层拒绝；显示启用不等于依赖就绪；迟到响应不覆盖新项目；忙时修改遵守现有限制                         | 有效策略、Scope/拒绝记录、项目切换结果                        |
| DR-07 外部 MCP | stdio/HTTP/SSE 各注册可信测试服务；紧凑发现→按需 schema，审批允许/拒绝；添加删除后目录刷新                       | undeclared/out-of-scope 工具拒绝；凭据宿主保管；外部 MCP 输出只是观察，不自动变 canonical 工程通过                       | 传输类型、发现/schema/执行轨迹、审批、脱敏目录                |

## Pack 更新前的本地／远程兼容验收

固定依赖的 Harness CI 只证明被固定的发布物，不能替代 Pack owner 最新候选版本的兼容验收。分别记录当前 pin、候选完整 SHA、内容摘要、实际加载路径和执行 profile；在独立工作区验证候选，不覆盖正式依赖或冻结快照。

| ID                 | 验收路径                                                                                                                                                       | 必须断言                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DR-08 本地期望传递 | 用候选 Pack 的生产 `execute` 返回值原样进入生产 verifier，覆盖 PCB verify 与 CAD build/inspect/export/edit                                                     | 正确期望通过；错误 bounds/volume/solids/footprints 不得通过，相关检查不得从 metrics 消失；自定义 tolerance 生效。不能只手工拼 verifier result，或只验远程 worker report |
| DR-09 证据兼容     | 本地和远程分别记录 artifact kinds、报告 schema/profile、原生版本、输入一致性和实际期望来源                                                                     | 本地成功产物满足其声明的证据契约；缺失/损坏报告、native failure、输入变化不允许 passed；runtime 版本与原生工具版本分开。不得伪造远程 profile 来接受本地证据             |
| DR-10 候选原生集成 | 在候选发布物及具备资格的原生环境运行现有 `tests/integration/freecad-runtime.test.cjs`、`tests/integration/pcb-godot-runtime.test.cjs` 对应套件，并重验远程路径 | 记录实际执行的工具与平台；FreeCAD 错误 volume 必须 failed，PCB 正确板/DRC 必须 passed，错误工程必须 failed。fixture 契约通过不能代替此项；前置不足记 blocked            |

候选 Pack 有不兼容时，先在 owner 修复并发布不可变版本，再进行 Harness pin 更新及完整 CI。2026-10-18 的 [issue #219](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/219) 已记录 [Domain Packs PR #47](https://github.com/Zhiman-BJ/industrial-domain-packs/pull/47) 后本地 expect 丢失与 PCB run report 缺失；早期 owner 本地候选 `b1ead81dd25f9093be5672584f8ce953fd0ad474` 的生产 execute→verify 契约测试 51/51 通过。该历史记录保留，不覆盖当时的环境失败。

最终修正已上传 [owner PR #48](https://github.com/Zhiman-BJ/industrial-domain-packs/pull/48)，远端 head `7dca82e` 的 tree 为 `444b34219c4eea1517324ffe90ecda5e59d66814`，与本地候选 `e2c4c41` 的 tree 一致。该 exact head 的 Domain CI、Architecture 和 trusted Architecture 检查均通过：JavaScript 113 pass / 0 fail / 1 skip，Python 23 pass / 12 skip，stdio 发现 25 tools，6 个 Pack tarball 构建成功；检查链接与历史结果见[审查报告](../reviews/main-review-2026-10-18.md)。这些结果不等于不可变发布、原生资格或完整 Harness E2E 通过。

PCB 原生执行被系统禁止 `sandbox_apply`，FreeCAD binary 缺失，DR-10 仍为 blocked；Harness 仍固定 `f91a8ab3c071e4500fd4097bb3123a7fbb0ca635`，本审查分支尚未发布，仍待候选发布物消费与原生验收，旧 pin 的测试通过不能将问题关闭。本轮 npm audit 另提示两项（1 moderate、1 high），在同一 issue #219 下待分诊；尚未确认影响、实施修复或验证修复结果。

## 自动覆盖缺口

普通 portable 主要验证失败/锁/传输 fixture，真实 release 下载、Docker classic/containerd 和各 OS 仍各自标注实际范围。原生软件的安装资格不自动等于所有工程任务资格。现有 macOS 历史原生、镜像证据不能推导 Windows/Linux 工程支持；独立 MCP 的成功响应不能替代 Runtime 的 Action/Artifact/Verification/Checkpoint。

[返回矩阵](modules.md)
