# Runtime 分发 v2 验收记录（2026-10-12）

状态：本地实现与下列验收通过。尚非签名、公证或公开发行版本。新用户提出的 REA 安装计划补强是后续提案，见 [方案评估](dependency-plan-review-20261012.md)，不计为本轮已实现能力。

## 身份与范围

- Harness 分支：`codex/runtime-distribution-v2-20261012`，基于 `f51f6a328e238ae55c30c93069f5c0d2b1fd874f`；代码与证据随本次提交保存。
- Domain Packs：0.7.0，固定提交 `4cc46c3f2e5d000e000e60e1ca0697d71484edd0`。根项目、Desktop、CLI 和 lockfile 使用同一身份。
- 本机：macOS ARM64；Go 1.26.2、Electron 44.0.0。Linux probe 只交叉编译，不代表 Linux 原生应用验收。
- 真软件验收使用已有 `/Applications/Godot.app`；CUDA 使用真实认证 HTTP MCP 传输及受控测试服务，未连接实际 RTX 4090 服务。
- 完整证据位于 [runtime-v2-20261012](qa-evidence/runtime-v2-20261012/)。

## 自动回归

| 命令／检查                            | 结果                                                                              | 证据                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm test:architecture`              | 47/47，未放宽架构例外                                                             | [architecture.txt](qa-evidence/runtime-v2-20261012/architecture.txt)                           |
| `node scripts/check-pack-release.cjs` | 18/18，包括签名、源锁、真实包组装和 probe 构建输入篡改拒绝                        | [release-contracts.txt](qa-evidence/runtime-v2-20261012/release-contracts.txt)                 |
| Pack Manager                          | 60/60；检测、签名/版本、项目绑定、租约、准备、损坏凭据隔离/恢复、解绑、兼容收据   | [pack-manager-tests.txt](qa-evidence/runtime-v2-20261012/pack-manager-tests.txt)               |
| Domain Runtime                        | 28/28                                                                             | [domain-runtime-tests.txt](qa-evidence/runtime-v2-20261012/domain-runtime-tests.txt)           |
| Harness Core                          | 35 pass / 1 opt-in skip；该原生项随后单独实际运行                                 | [harness-core-tests.txt](qa-evidence/runtime-v2-20261012/harness-core-tests.txt)               |
| 共享 TaskService                      | 17/17，包括真实 projectDir 解析                                                   | [harness-application-tests.txt](qa-evidence/runtime-v2-20261012/harness-application-tests.txt) |
| CLI                                   | 19/19                                                                             | [cli-tests.txt](qa-evidence/runtime-v2-20261012/cli-tests.txt)                                 |
| Desktop Node                          | 53/53；包括旧 repair IPC 不再整域下载                                             | [desktop-tests.txt](qa-evidence/runtime-v2-20261012/desktop-tests.txt)                         |
| 源码质量                              | 最终 renderer build、格式检查及 diff 检查通过；ESLint 0 errors，仓库仍有 warnings | 本轮工具日志                                                                                   |
| Owner                                 | 86 项：84 pass、2 原生 opt-in skip；内容锁、架构与 Go race 通过                   | [owner-components.json](qa-evidence/runtime-v2-20261012/owner-components.json)                 |

## 实际路径

| 路径                                | 实测结果                                                                                                                                              | 证据                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner 独立发行                      | 最终 4cc46c3 的六 Pack source/skills/bridge 归档均从已提交 Git 对象构建并逐一 inspect                                                                 | [owner-components.json](qa-evidence/runtime-v2-20261012/owner-components.json)                                                                                                 |
| Go → 原生 Godot → canonical Runtime | source-only Pack 安装、已有应用发现/签名/版本、项目关联、真实 12 帧 BoxMesh/位置核验 passed；probe identity 入收据，解绑使旧配置失效；没有 Godot 下载 | [native-godot.txt](qa-evidence/runtime-v2-20261012/native-godot.txt)，约 10.3 秒                                                                                               |
| CUDA 连接                           | 安全 store 配置→显式关联→已安装 Pack→认证 HTTP Compiler/Evaluator 握手与调用；public view 不含 token                                                  | [remote-and-cancellation.txt](qa-evidence/runtime-v2-20261012/remote-and-cancellation.txt)                                                                                     |
| 取消／执行后校验失败                | 即使 verifier 无条件返回 passed，canonical veto 仍降为 insufficient_evidence；真实 receipt/产物保留，不进入 verified                                  | 同上                                                                                                                                                                           |
| 真实 renderer → preload → IPC       | 多安装选择、版本失败、检测/关联、取消、项目隔离、字体/暗色窄屏、OS 加密存储、坏密文明确重置、延迟 IPC 跨项目不串状态、保存不假装可取消                | [desktop-environments/report.json](qa-evidence/runtime-v2-20261012/desktop-environments/report.json) 及同目录截图                                                              |
| 实际五域发行目录                    | Chip/PCB/Godot/CAD/CUDA 全部可选并完成 Pack-only 安装，未触发环境准备；native hpack 含真实 Go 组件                                                    | [five-domain-catalog/report.json](qa-evidence/runtime-v2-20261012/five-domain-catalog/report.json)                                                                             |
| 最终封装 .app                       | 实际应用内 bootstrap 五域首次选择、全选安装、状态展示与正常 app.quit 成功；无假目录替换，无软件下载                                                   | [packaged-five-domain/report.json](qa-evidence/runtime-v2-20261012/packaged-five-domain/report.json) 及截图                                                                    |
| 旧安装专项迁移                      | Pack-only→明确环境准备→故障/重试、中文/窄屏；正常退出中断显式下载保留 Pack、释放锁/临时文件                                                           | [installation-fixtures.json](qa-evidence/runtime-v2-20261012/installation-fixtures.json)、[quit-during-prepare.json](qa-evidence/runtime-v2-20261012/quit-during-prepare.json) |

GUI 环境测试使用签名 fixture 应用，不能视为所有厂商软件资格。早期 fixture 目录只含一个测试包，所以曾对五域显示“Not offered by current catalog”；真实五域目录和最终 .app 均无此缺失。旧截图不能用于宣称真实发行目录缺包。

## 复跑方式

先安装固定依赖并构建小型平台组件：

```sh
pnpm install --frozen-lockfile
node scripts/build-platform-probe.cjs
node scripts/build-pack-distribution.cjs dist/domain-packs-v2-new
pnpm --filter @industrial-agent-harness/desktop build
```

`build-platform-probe` 从固定 npm owner 的经内容锁验证的 Go 源构建；也支持通过 `HARNESS_PLATFORM_PROBE_INDEX` 输入相同 owner commit 的可信独立构建。用户安装时不编译 Go。发行目录需要完整 probe 输入，声明了 probe 后损坏/缺失不能回落为 JS。

```sh
HARNESS_TEST_NATIVE_ENVIRONMENTS=1 \
HARNESS_TEST_PLATFORM_PROBE=dist/platform-probe/darwin-arm64/industrial-environment-probe \
node --test packages/harness-core/tests/runtime-environment-native.test.cjs
node --test tests/integration/industrial-cuda-installed-pack.test.cjs packages/harness-core/tests/runtime-environment-results.test.cjs
```

Desktop 环境与实际目录的独立存储、截图及命令见 [Desktop QA](../apps/desktop/QA.md)。固定 probe 只检测版本；domain MCP 未整体改写 Go。

## 未验或未扩大的范围

未新增 Mac Docker CI runner。未重新进行所有厂商软件冷下载、完整 KiCad/FreeCAD 全新安装、真实 GPU 服务、完整 Chip/PCB 原生工具链、Windows 或 Linux 原生用户安装。CAD packaged 工程门禁已改为显式准备流程，但本轮未重新下载其大体积软件运行完整门禁。

最终 .app 为本地未签名候选，未做 Developer ID、公证、公众 Gatekeeper、DMG 发布或 Core OTA。历史首装冷下载失败及其总超时/无断点续传问题不因本次 Pack-only 流程而被宣称修复。现有下载缓存复用不等于断点续传或持久任务恢复。

下一阶段 Plan/Doctor、REA npm bundle、逐 capability 依赖图和 Windows Recipe 尚未实现；详情见 [REA 方案评估](dependency-plan-review-20261012.md)。
