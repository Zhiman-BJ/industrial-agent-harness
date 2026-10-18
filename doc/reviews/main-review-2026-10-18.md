# Main review — 2026-10-18

统一问题跟踪：[GitHub issue #219](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/219)。初次本地修复提交 `3b6d907`、`b610dbc` 及后续文档已提交 [Harness PR #220](https://github.com/Zhiman-BJ/industrial-agent-harness/pull/220)；最新完整 CI 发现与待验证修复见文末，不将 PR 提交等同合并或正式发行。

## 基线与边界

基线为 `4e8cc44b9a0dcb3d8d801558a10fea7b55027e8b`，工作结束前再次核验 GitHub main 仍为此 SHA。shell 的 Git fetch 因 DNS 失败，使用已有的同 SHA Git 对象建立独立 worktree，分支 `codex/main-review-20261018`。未将不在 main 的 PR #209 当成本次基线。

范围包括 Desktop UI、重复实现、测试覆盖、展示性能、崩溃恢复、资源退出，以及最新产品对应的模块化 QA。生产变更只在 Desktop 展示助手、弹窗键盘焦点和布局；未改变核心决策、审批、领域执行、认证协议、IPC/API、依赖版本或已调通接口。独立复核实际 diff，另外执行了 500 组事件和 500 组历史的新旧实现差分，输出一致、输入未变。

这是有证据和明确缺口的审查，不代表全仓所有路径或全平台发布验收通过。

## 确认问题与处理

| ID                 | 问题与复现                                                                                                               | 修复及回归                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI-01 / P2         | 模型/新建项目弹窗没有初始焦点、Tab 边界和 Escape；账户弹窗刚打开时 Shift+Tab 能逸出                                      | 三种弹窗共用 `attachModalFocus` / `useModalFocus`，删除账户重复实现；保留最新关闭回调，卸载清理监听并恢复仍存在的 opener。新增 3 个单测和共享原生键盘断言 |
| UI-02 / P2         | 短窗口长表单整体滚动，标题和操作按钮离开可视区                                                                           | 字段区域独立滚动，标题/页脚保留；原生 640×480 回归通过                                                                                                    |
| UI-03 / P2         | 未选择项目时按 Escape，`fullscreenElement === workspace.current` 的两个 null 被误判为全屏；残留错误在 800px 布局造成溢出 | 增加非空守卫，全屏切换清除陈旧错误，状态行可换行。原生测试先复现 `tabs-800: panels must fit the window`，修复后通过                                       |
| TEST-01 / P2       | 事件归并、重复/迟到历史、消息块和工作区文件边界覆盖缺口                                                                  | 四模块新增 14 个回归用例，连同原用例 19/19 通过；这四个文件的行/分支/函数覆盖均 100%，不代表整个 Desktop 100%                                             |
| PERF-01 / P2       | subagent 更新逐项 findIndex；每个历史 turn 都过滤全部新事件                                                              | 懒建 ID→index Map、按 turnId 分桶。保留首个重复 ID、原位置、事件到达顺序、未匹配事件 revision 等语义                                                      |
| QA-01 / P2         | 单文件 runbook 的依赖身份、CI 分层、账户验收、领域包与诊断描述落后；没有性能/crash模块                                   | 保留旧入口，拆出协议、T0–T6、模块矩阵和七个验收模块，明确命令、平台、前置、通过/阻塞/skip、证据及失败恢复                                                 |
| TEST-02 / 覆盖缺口 | Renderer reload 不能证明真实 Renderer crash 恢复                                                                         | 在 parallel selftest 增加专用窗口强制 crash、主进程读取已落盘历史、测试显式 reload、历史/终态去重、失效控件不复活和同聊天后续任务；不承诺自动自愈         |

冗余审查还检查了 DomainManager/CapabilityCenter 的轮询：完成动作和刷新责任不同，未为表面相似而合并。工具事件的不可变数组复制与核心持久化路径亦未擅自重构。

## 补充核查：Pack PR #47 本地验收回归

2026-10-18 按用户指出的两处风险，对照 Pack main `de87a6539ddadf73b7e5b7ef94fa59ae606264fb` 与 [Domain Packs PR #47](https://github.com/Zhiman-BJ/industrial-domain-packs/pull/47) 前 `1775bdcaa8e283bb6d76a34d5dc38566e3d92bb3`。初次核查确认两项均存在，**此前修复未包含，初次核查也未修改领域生产代码**；已追加至同一 issue #219，后续 owner 修复进展见下文。Harness 仍固定 `f91a8ab3c071e4500fd4097bb3123a7fbb0ca635`，因此本轮原有测试不能证明最新 Pack 兼容。这是此前跨仓候选版本覆盖的遗漏。

| ID             | 本地契约复现                                                                                                                                                                                           | 修复状态                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| DOMAIN-01 / P0 | PCB 原样 execute 返回没有 `expect` 或 `report.pcb.run`；同一结果旧 verifier passed，新 verifier insufficient_evidence（缺 report）。只补合成 run report 后，仍因缺显式 bounds insufficient_evidence    | owner PR #48 最终候选 7dca82e 已修复契约且 CI 通过；原生验收 blocked，Harness pin 未变 |
| DOMAIN-02 / P1 | FreeCAD 合成几何为 volume=100、solids=1、bounds=[10,5,2]，传入错误要求 999、2、[99,99,99]。旧 execute→verify failed，新路径 passed 且三个 expected metrics 消失；给 result 补 expect 的对照再次 failed | owner PR #48 最终候选 7dca82e 已修复期望及 tolerance 传递且 CI 通过；原生验收 blocked  |

两组复现均执行精确快照的生产 execute/verifier，分别在 PCB `runtimeApi.executeTask` 和 FreeCAD `child_process.spawn` 边界合成原生输出。这是契约回归证据，**不是实际 KiCad/FreeCAD 或完整 Harness E2E 验收**。脚本、源码快照和 JSON 结果在 `dist/ci-reports/local-verifier-regressions-20261018/{pcb,freecad}/`；复制后可分别运行 `node test.cjs` 与 `node contract-test.cjs` 重现。

回归基线 de87a653 中，Harness `packages/domain-runtime/src/industrial.cjs:470–490` 原样传递 execute result。PCB `index.cjs:312–329` 未产出新 verifier 所需的 run 报告；verifier 比较的是 **report.toolVersion**，不是 runtime 的 result.toolVersion，不能把 runtime 0.3.1 改写为 KiCad 10.0.6 来伪装修复。缺证据返回 insufficient_evidence，原生版本检查不符返回 failed。FreeCAD `index.cjs:215` 改读 result.expect，但 `:393–406` 本地返回值未携带；原 inputs.json 虽保存期望，verifier 未读取，native.py 也不执行这些期望检查。

PR #47 新增 Python 测试只验证远程 worker report 保留 expect，并 mock run_native。Harness 已有本地原生集成测试及 FreeCAD 错误 volume 断言，问题在于未对候选 Pack 执行，不能说所有仓库都没有本地集成测试。远程 report 带 expect 不等于本轮已完成远程资格验证。

后续 Pack owner 早期本地候选 `b1ead81dd25f9093be5672584f8ce953fd0ad474` 补齐本地 expect 快照，并协调 PCB 本地 profile/报告与 verifier 的证据契约；生产 execute→verifier 正反例 51/51 通过。当时 owner 全量 npm 测试为 109 pass / 4 EPERM blocked / 1 skip，不能记作全量通过。这些本地历史失败保留，后续 CI 通过不覆盖原结果。

最终修正已上传 [owner PR #48](https://github.com/Zhiman-BJ/industrial-domain-packs/pull/48)，远端 exact head `7dca82e` 的 tree 为 `444b34219c4eea1517324ffe90ecda5e59d66814`，与本地候选 `e2c4c41` 的 tree 一致。首轮 CI 发现的 PCB 测试夹具 macOS 路径依赖修正已包含在该最终候选中，已完成上传及重跑，不再处于“待上传”状态。该 head 的最新检查均通过：

- [Domain CI 39116935904](https://github.com/Zhiman-BJ/industrial-domain-packs/actions/runs/39116935904)：JavaScript 113 pass / 0 fail / 1 skip，Python 23 pass / 12 skip，stdio 发现 25 tools，6 个 Pack tarball 构建成功。
- [Architecture 39116935912](https://github.com/Zhiman-BJ/industrial-domain-packs/actions/runs/39116935912) 与 [trusted Architecture 39116934409](https://github.com/Zhiman-BJ/industrial-domain-packs/actions/runs/39116934409) 均通过。

上述 owner CI 不代表原生资格或完整 Harness E2E 已完成。PCB 原生执行被系统禁止 `sandbox_apply`，FreeCAD binary 缺失，两项原生验收仍为 blocked；Harness pin 未变，仍待 owner 不可变发布物及候选消费验收，本审查分支的 Harness 修复尚未发布。未修改 Harness 冻结快照或通用 Runtime，未降低验收条件。QA 模块 DR-08–DR-10 继续区分当前 pin 与候选 Pack、本地与远程、fixture 与真实原生。

新增依赖审计项 **DEP-01（issue #219）**：本轮 npm audit 提示 2 项，分别为 1 moderate、1 high。目前未分诊，尚未确认影响组件、可达性及修复方案；没有实施或验证漏洞修复，不以 CI 绿色或领域契约修复宣称审计问题已解决。

## 性能测量

同机、同输入、旧实现后新实现顺序执行；fixture 构造不计入耗时，一次 warmup，通常 5 次测量取中位。下表是展示助手 CPU 时间，不是 UI 帧耗时或生产模型速度。

| 场景                                         |     旧实现 |     新实现 |
| -------------------------------------------- | ---------: | ---------: |
| 4,000 个 subagent 各更新一次                 |  22.138 ms |   0.140 ms |
| 4,000 个 turn 各到达一个晚事件               |  34.362 ms |   0.528 ms |
| 16,000 个 tool events 逐个小批追加（未优化） | 199.259 ms | 195.859 ms |

可复用测量脚本为 `scripts/benchmark-desktop-display.cjs`，有正确性断言、原始样本及输入规模，没有凭空设定性能 gate。App 已使用 16ms 批处理；逐条 tool 压力不能等同每个生产 token 都复制大数组。

`benchmark:maintenance` 三个独立进程、各运行原脚本 5 次：8 MiB 日志中位 8.74ms，200 capability×10 policy 37.01ms，1000 短 chunk 入库 53.65ms；Node 峰值 RSS 范围 235.44–235.66MiB。退出资源探针只观察到 stdio 管道，不等于全应用无泄漏证明。

保留两项风险：

- **PERF-02：ChatStore 写放大。** 每个 chunk 解析/序列化并重写全部累计文本，累计处理字节随 chunk 数平方增长。固定 32 字节 chunk，每档 3 样本，500/1000/2000 条中位 38.62/85.77/217.38ms；4 倍输入耗时 5.63 倍，均正确合并为一条事件。涉及核心持久化时序，本轮只取证，不修改。
- **PERF-03：连续小批 tool events 的数组复制。** 16k 单个大 batch 约 0.25ms，逐个小 batch 约 200ms。真实影响依赖批大小和聊天规模，保留风险，未改 React 不可变状态语义。

没有统一启动/交互/RSS SLA，也没有同机历史生产基线，因此不将采样完成写成“性能合格”。已有功能性超时、取消和额度边界照常判断。

## 本地验证

计数按独立执行列示，可能重叠，不能相加作为唯一用例总数。

| 执行范围                          | 结果                                      | 限制                                                                                                                     |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Desktop TypeScript / Vite build   | 通过                                      | 保留已有 large chunk 警告                                                                                                |
| 格式、变更代码 ESLint、diff check | 通过                                      | 全仓早期 lint 0 error / 94 warning；CSS 不属于 ESLint 配置，使用 Prettier检查                                            |
| Architecture checker              | 通过                                      | contract 负向测试另为 19 pass / 1 环境失败：candidate-fetch 收到 `spawnSync git ENOBUFS` 而非预期 size-limit；未弱化断言 |
| Desktop Node 全套最终执行         | 74 项：73 pass / 1 blocked                | account IPC 测试 `listen EPERM 127.0.0.1`；原生 account 自测另已通过，不能替代该 Node suite 的失败记录                   |
| 四个展示模块覆盖回归              | 19/19 pass                                | 限四模块 100% 行/分支/函数；另有焦点 3/3                                                                                 |
| CI 分区 / QA cleanup 测试         | 17/17 pass                                | cleanup 只做 preview，0 个可删，未执行 apply                                                                             |
| 依赖修正后定向测试                | 51 项：45 pass / 6 blocked                | 4 个 CLI 用例明确传 environment={}，触及默认用户配置；2 个 loopback 受限                                                 |
| 恢复/资源/取消定向                | 22/22 pass                                | killed runtime、DB 版本保护、额度、慢/失败释放、内存压力、取消及子代清理                                                 |
| 低层 shutdown/cleanup             | 49 pass / 1 allowed KLayout skip / 0 fail | 另一个 CodeSession startup-close 用例被 loopback EPERM 阻断                                                              |
| 原生 Desktop                      | 9 个套件见下                              | 源码模式，不能当作安装包或全平台验收                                                                                     |

真实工程定向验证包含：Verilator 的状态→Broker→Runtime→成果→校验→Checkpoint、restart/stale-input；真实超时/取消与子代清理、凭据隔离、编译失败/断言失败区分、拒绝 scope/approval；签名安装 Chip Pack 的不可变 inventory 和重启；iverilog/vvp 的独立工程验证。没有调用真实生产模型或线上远程任务。

原生套件为 `ui`、`account`、`messages`、`language`、`gui-settings`、`documents`、`browser`、`model-sync`、`parallel`。使用现有 Electron 44 app 正常启动对应源码 selftest；每次测试有独立临时 profile/project。外部 launcher 只提供日志、截图及不改变返回值的清理阶段观察，模拟源码启动的 `isPackaged=false`，结束后恢复。`gui-settings` 实际 screen/accessibility 权限均为 denied；只验证状态与入口，没有授予权限。

UI 覆盖最小窗口、焦点、主题/对比度、中英文、workspace/tabs、布局持久化、120-turn 消息导航和草稿；documents 覆盖 6 viewers / 9 formats、导航/全屏状态、恶意或错误输入、超限和项目隔离；parallel 覆盖 200 次导航、160 次同帧双击、资源容量、后台审批、重复 Stop、迟到历史及活动任务关停。

真实 Renderer 注入最终通过：Electron 报告 `reason=killed, exitCode=2`（该 API 允许 killed/crashed），原 main 存活，持久层与 IPC 各自前后历史一致，结果只出现一次，旧审批/Stop 不复活，同一聊天的新任务完成。正常与活动任务套件均观察到 `will-quit`；这只证明本次应用关停，不能推断整个系统进程树无孤儿。

## 所有环境与调查记录

- **ENV-01：依赖污染。** 初始复制的 domain-packs 是 `1eae41d…/0.7.0`，lock 要求 `f91a8ab…/0.5.3`。恢复本地精确缓存，验证 571 个 content-lock 文件、79 个 direct dependency version/workspace target。未改 manifest 或 lock。其余第三方依赖仍有只读外部 worktree 链接，复制的 pnpm 元数据不等于 clean frozen install。修复中曾经沿 scope symlink 误改两个其他 worktree 依赖链接，已立即恢复原目标并独立核验；没有修改其他源码。
- **ENV-02：宽范围 portable 未通过。** 原执行 631 项：517 pass / 113 fail / 1 allowed KLayout skip。失败分类为 loopback 92＋父聚合 1、默认配置写入 8、错误 domain 依赖 8、SDK/CLI 配置继承 2、网络安装 1、DMG 设备 1。定向重测消除 8 项依赖错配、2 项配置继承和1项可隔离 CLI；未重跑全 portable，也不将剩余失败改记通过。
- **ENV-03：启动/计量限制。** shell 直接 Electron SIGABRT，正常原生 app 启动可运行上述套件；`/usr/bin/time -l` 的 sysctl 被拒，改用 Node resourceUsage/memoryUsage 采样，不修改系统保护。
- **OBS-01：调试窗口退出滞留。** 临时保留失败窗口的 launcher 中观察到关闭窗口后进程未及时退出；恢复原生 app.exit 后，常规/活动会话的 before-quit→will-quit 均完成，未证实产品关停缺陷。源码等待链保留为后续调查线索，没有无依据修改核心生命周期。
- **TEST-03：新增 crash 测试初版 oracle 不正确。** 把原始 ChatStore 与经过派生状态补充的 IPC 历史直接全等比较，因 executionStatus/historicalGroups 差异失败。修正为持久层前后、IPC 前后各自同层比较，保留唯一结果、终态、恢复续跑断言；不是产品数据丢失。
- **OPS-01：GitHub 连接器 issue create 返回 403。** 使用已登录的正常 GitHub 网页发布本轮唯一汇总 issue；不改变凭据或权限。

## 证据与剩余验收

原始证据保留在本 worktree 的 `dist/ci-reports/`：`local-review-native-20261018/`、`local-review-baseline-20261018/`、`local-review-coverage-20261018/`、`local-review-performance-20261018/`、`local-review-performance-baseline-20261018/` 和 `local-review-gates-20261018/`。初始失败日志未被覆盖；native summary 以每个 suite 最后一次完整执行为准。

仍需干净、不受限 runner 的 frozen install、全 portable/contract gate、正式打包和 Windows/Linux 原生验收，以及真实远程执行成功/失败/同步。Renderer 显式 reload 恢复不证明自动自愈；main crash/重启、在途各阶段 crash、长期 UI 内存泄漏、跨平台完整进程树无孤儿、首屏可交互时延仍未完整验证。具体操作与证据要求见 [qa-runbook](../qa-runbook.md) 的七模块矩阵。

## PR #220 发布与完整 CI 后续发现

Harness 修复已通过正常 GitHub UI 提交至 [PR #220](https://github.com/Zhiman-BJ/industrial-agent-harness/pull/220)。远端 head `fe18d5c` 的 tree 为 `5c5975eb99a819442df5e4c9ed8bfa0b2838558a`，与本地提交 `d0ff6e5` 一致；UI 提交的 commit SHA 不同，不影响这次已核对的内容一致性。

该远端 head 的[常规 PR CI 39118290515](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39118290515) 全部成功；独立的 [Architecture 39118290481](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39118290481)、[trusted Architecture 39118289172](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39118289172) 和[账户检查 39118290490](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39118290490) 也成功。这不代替 full=true 的完整安装与原生验收。

随后手动触发的 [full=true run 39118388104](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39118388104) 发现以下两项，继续放在同一 issue #219。修复已进入本地工作区，尚需新 head 的远端 CI 验证；该完整运行不能记作全绿。

| ID      | 完整 CI 的发现                                                                                                               | 本地修复与验证边界                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEST-04 | Windows 安装器子进程 readiness 文件已存在但 PID 字节尚未写入；测试读取空串后 `Number('') === 0`，错误地用 PID 0 做 reap 断言 | 仅修改 `packages/pack-manager/src/runtime-assets.test.cjs`：在原 5 秒 readiness 预算内等待正整数 PID，保留 2 秒 reap 期限；新增空文件与 PID 0 不得提前就绪的回归。定向 24/24 通过，未放宽安装器或子进程清理验收                                                 |
| CI-01   | full 模式的 macOS Desktop 安装链路没有先准备官方 runtime archives，报告缺少 KiCad/Godot/FreeCAD 归档                         | 仅在 `.github/workflows/desktop-package.yml` 的 macOS 且 full 条件下调用既有 `node scripts/prepare-ci-runtime-archives.cjs --download`；沿用官方大小/hash 校验及 `GITHUB_ENV` 归档传递。原安装、修复、工程、Viewer 与重启断言全部保留，尚待远端完整安装流程验证 |

主线程独立复验 runtime-assets 定向 24/24 及 architecture checker 通过。architecture-contract 负向测试为 19 pass，加既有 candidate-fetch 的 `spawnSync git ENOBUFS` 环境阻塞 1 项；它是上文已登记的同一环境问题，不新建缺陷 ID，也不改记通过。没有据此修改架构 checker、policy 或契约断言。

本节补充发布与远端验证进展，先前本地失败、owner 原生 blocked、旧 Harness Pack pin、DEP-01 待分诊及其他未完成验收继续保留。下一步以包含 TEST-04/CI-01 修复的新远端 exact head 重跑完整 CI；在结果出来前，不宣称这两项已经获得 CI 关闭证据。

## 完整 CI 第二轮：已验证修复与剩余前置

本轮远端 head `37432cfd` 与本地 `cfbc78d` 的 tree 均为 `f07a0e499ccb154bf327cf6438b4429f95e86541`。[常规 CI 39119071261](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39119071261)、[Architecture 39119071255](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39119071255)、[trusted Architecture 39119070032](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39119070032) 和[账户检查 39119071270](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39119071270) 均成功。上轮失败和修复前的结果继续保留；以下是新 [full=true run 39119144487](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39119144487) 的阶段性证据，不是完整运行全绿结论。

| 项目                | 本轮证据及范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEST-04             | Windows Portable 已成功，PID readiness 修复获得新 head 的 Windows 回归证据；该项已关闭，不改变原 5 秒 readiness 与 2 秒 reap 预算                                                                                                                                                                                                                                                                                                                                                                                           |
| CI-01               | [macOS Desktop job 117651160211](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39119144487/job/117651160211) 的官方归档准备和 full Domain 安装步骤已成功，关闭缺少归档的前置问题；记录时后续 CAD 验收仍在运行，不能将前置成功扩展成整个 Desktop job 或 CAD 通过                                                                                                                                                                                                                                        |
| 原生 vertical slice | [macOS 26 job 117651160159](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39119144487/job/117651160159) 整 job 成功；核对 native 68/68、无 skip，headless 1/1，Desktop FreeCAD Viewer 与 external MCP 步骤成功。macOS 15 的 native 步骤也已成功，记录时正在 Viewer 步骤，尚不宣称整 job 成功                                                                                                                                                                                                           |
| CI-02               | 独立安装组 [macOS 15 job 117651160225](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39119144487/job/117651160225) 与 [macOS 26 job 117651160187](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39119144487/job/117651160187) 均在 PCB/Godot 安装遇到 Docker `ENOENT`，各为 3 tests / 1 pass / 2 fail / 0 skip。runner 没有真实 Linux engine，主线程核查仓库当前也没有已配置的 self-hosted runner。保留失败与所需前置，不改安装语义、不放宽 gate，也不将缺 Docker 改记成功或 skip |

新增 **CI-03（同一 issue #219）**：静态调用链确认，官方归档 helper 导出 `HARNESS_FREECAD_ARCHIVE`，但 `scripts/smoke-packaged-cad.cjs` wrapper 没有映射为 selftest 所读取的 `HARNESS_CAD_INSTALL_ARCHIVE`，因此隔离 cache 的 seed 路径缺失。DomainManager 的预检留在导入界面，是当前约 20 分钟等待的调查线索；此时已确认变量传递缺口，真实运行日志与该等待的最终归因仍待核对。修复只在测试 wrapper 传递该路径，保留显式 CAD 归档优先及无值行为。新增回归启动真实 Node 子进程核对三种输入，修复前实际漏传、修复后通过；主线程独立重跑该回归、契约 marker 与归档 helper 合计 5/5 通过（定向筛选，不包含本机受限的 DMG 挂载用例）。语法、格式及 architecture checker 通过。未变更生产安装逻辑、超时或真实 CAD 验收断言，尚不记作远端 CAD 验收通过。

后续 job 终态及新修复 exact head 的完整 CI 结果继续追加到 PR #220／issue #219；本记录不为每个运行中步骤反复改写既有历史。CI-02 的环境前置和 CI-03 的修复验证尚未完成，完整发布、候选 Pack 消费及此前其余验收缺口继续保留。
