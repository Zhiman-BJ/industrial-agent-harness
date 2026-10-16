# Micius Harness 开源版发布流程（OSS Release Runbook）

- 日期：2026-10-16
- 状态：流程已定稿（文末「待用户定案」未清零前，真实发布被门禁阻断，只能演练）
- 来源：用户 2026-10-16 决定（正式版交 Micius Harness）、[#100](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/100) 双版本 Epic、[doc/editions.md](editions.md)、[#106](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/106)–[#109](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/109)
- 角色：内部仓库（本仓库，internal edition）唯一开发与 PR 落地点；外部仓库 **Micius Harness**（OSS edition）只接收经清单批准的版本快照。本文是两个 edition 之间发布交接的操作手册。

## 1. 原则（先读）

1. **单一事实源**：`architecture/editions.json`（IH-EDITIONS-001）是公开/内部归属的唯一事实源。导出、发行、CI 都只消费清单，任何环节不得自建排除规则。
2. **导出器独占**：公开树只能由 #106 导出器从固定 source SHA 生成，禁止手工拷贝文件进外部仓库（手工拷贝无法审计、必然漂移）。
3. **门禁显式阻断**：`release` 块待定（仓库名/URL/分支/许可证任一为空或 pending）时，`--gate release` 失败，真实发布不可能发生；本地导出演练不受影响。
4. **不代用户定案**：许可证、外部仓库地址等登记为 pending 的事项由用户拍板后填入清单，实现 agent 不得代填。

## 2. 首发前置：待用户定案清单（阻断项）

下表任一项未定案，发布门禁即阻断。定案后以 PR 更新 `architecture/editions.json` 的 `release` 块（该文件是 public 条目，改动不触治理哈希，无需架构修订流程）。

| 事项 | 当前值 | 建议（仅供拍板参考） | 拍板后落在哪 |
| --- | --- | --- | --- |
| 外部仓库名称 | 空 | 产品名已定 Micius Harness；repo slug 建议 `micius-harness` | `release.externalRepoName` |
| 外部仓库 URL | 空 | 建议 GitHub 上新建独立公开仓库（org 待定：Zhiman-BJ 现有 org 或新 org） | `release.externalRepoUrl` |
| 外部默认分支 | 空 | `main` | `release.externalDefaultBranch` |
| 许可证 | `pending` | 本仓库现为 MIT；沿用需用户确认 | `release.license` |
| OSS 版本号 | 无 | 首版 `v1.0.0`，与内部首个正式 desktop 版共用同一 source SHA（"正式版交 Micius"即双轨同源） | 公开仓 tag 命名约定（#107 映射表） |
| OSS 应用身份 | 无 | productName「Micius Harness」+ 独立 appId + 独立数据目录 + 独立更新源；与内部版同机共存互不读写（editions.md §6） | #108 的身份配置接口 |
| 发布节奏 | 无 | 双周检查发布资格、紧急修复加急（#100 建议） | 本手册 §5 执行频率 |
| 贡献者归属方式 | 无（#107 协议：公开发布提交采用已配置身份，不复制内部消息/PR 链接，不伪造贡献归属，git 历史不带入个人作者） | 三选一或组合：①每版公开 release notes 附经审核的贡献者名单；②公开树维护一份人工筛选的 AUTHORS/CREDITS 文件；③仅在 GitHub 侧授予协作者/维护者权限，不涉 git 归属。任何公开名单须本人同意后才进入导出面 | #107 发布提交协议、#108 公开发行说明 |

## 3. 首发前置：工程缺口（按依赖排序）

截至 2026-10-16（main=2c3c2fe）的状态：

| 序 | 事项 | 状态 | 为什么是前置 |
| --- | --- | --- | --- |
| a | 合并 PR #128（apps.cli、packages/sdk 转 internal，去 CLI 化 README/CONTRIBUTING） | OPEN | 已拍板的产品边界，不合并则导出面与决定不一致。注意：分支基于旧 main，合并前需 rebase，且其新增决策编号 PD-071 与 main 现有 PD-071（HTML 沙箱预览）冲突，须顺延重编号 |
| b | #102 构建隔离收尾 | OPEN（P0） | release 门禁规则：任何 `planned` internal 条目仍有活引用即阻断。当前台账：诊断四条目 6/1/1/3；#128 合入后另增 CLI=2、SDK=3 的引用待收敛 |
| c | #106 导出器 | OPEN（P0，未开工） | 公开树唯一合法生成器；输入输出契约见 editions.md §4（固定 source SHA、公开树、派生公开清单、私有审计报告、确定性变换）。**先做演练模式**（release 块为空也允许），首发前用它完整走一遍 §4 的 T1–T5 |
| d | #107 公开历史同步 | OPEN（P0） | **首发只需最小形态**：单条整理后的初始提交（不带内部历史）。版本映射与幂等恢复可首发后补齐，不阻断首发 |
| e | #108 应用身份与更新渠道 | OPEN（P1） | OSS 桌面安装包需要独立 appId（现为 `com.zhiman.industrial-agent-harness`）/productName（现为 Industrial Agent Harness）/数据目录/更新源，以及公开仓内重建的公开发行工作流（内部 desktop-package/release-desktop 不导出） |
| f | #109 迁移、演练与端到端验收 | OPEN（P1） | 即本手册 §4 T7 的验收步骤，按 checklist 执行 |

## 4. 首发操作序列

每步标注门禁与产物。T1–T5 在演练模式（release 块为空）下可完整预演。

- **T0 冻结基线**：从 origin/main 选定 source SHA，记录内部对应版本（预期为首个 desktop 正式版，接替 desktop-v1.0.1-beta.4）。此后该 SHA 不得 rebase。
- **T1 填 release 块**：PR 更新 `architecture/editions.json`（§2 表定案值；确认全部条目 `decisionStatus=decided`）。跑 `pnpm test:editions`。
- **T2 过发布门禁**：`node scripts/check-editions-manifest.cjs --gate release` 必须 `ok: true`。失败即停，逐条修（常见：license pending、planned 条目活引用未清零）。
- **T3 导出**：运行 #106 导出器，输入 T0 的 SHA。产物三件：公开树、派生公开清单（只含 public 条目）、私有审计报告（留在内部，与公开物严格分离）。
- **T4 审计报告核对 + 泄密扫描**（人工，双人复核）：
  - 审计报告逐条过：排除规则命中均为预期条目，无「意外多删/少删」；
  - 公开树上 grep 四类不公开能力的痕迹：`doc/` 路径引用、诊断（diagnostic/inspect-log/AgentLogPanel）、录制重放（harness-recording/harness-replay/demo）、内部机械（policy.json/architecture-contract/check-architecture/Harbor/内部 token 与 secret 名）；
  - `THIRD_PARTY_NOTICES.md` 原样在树内且与内部一致（第三方归属不得抹除）；README 双语 verbatim、锚点齐全（publicStatementSource 全部可达）；
  - lockfile 已按公开包集合重新生成且可复现（`pnpm install --frozen-lockfile` 干净通过）。
- **T5 演练组装**（可选但强烈建议）：在本地空目录以 git 仓形态组装公开树，跑公开 CI 集（ci/structure/industrial-core/industrial-linux/account-login），全绿才继续。
- **T6 建外部仓库并推送**：按 §2 定案建空公开仓库（默认分支按定案），公开树作为**单条整理后的初始提交**推送（不带内部历史）。确认公开 workflow 集随树生效、首跑全绿。
- **T7 打 tag 与发行**：公开仓打 `v1.0.0`（或定案版本号）→ 公开发行工作流（#108）出桌面安装包与校验和。Release 正文遵守 [releases/README.md](../releases/README.md) 同一诚实披露标准：实际能力/接口性组件/外部依赖（模型密钥、工业软件）/未打通路径/下载与校验说明；不把 Kimi SDK 能力列为自研。
- **T8 端到端验收（#109）**：见 §6 DoD。验收通过前，对外不宣传、不公告。
- **T9 公告与归档**：双语 README、SECURITY 上报渠道就位后公告；T3 审计报告与 T4 复核记录归档到内部（发行留痕）。

## 5. 后续例行发布（#107 落地后）

1. 选 source SHA → `pnpm test:editions` + `--gate release`（同 T1/T2）；
2. 导出器生成新版公开树（幂等：同一 SHA 重跑必须产出逐字节相同的树）；
3. 公开仓追加**单条整理后的发布提交**（不带内部提交历史），提交信息含内部 SHA 映射（#107 映射表）；
4. 打 tag、出包、按 T4 做泄密扫描（每次必做，不等累积）；
5. 中断恢复：任何一步失败按 #107 幂等恢复规则重入，禁止手工修补公开仓。

## 6. 首发验收 DoD（#109）

- [ ] `--gate release` ok；导出审计报告与人工复核记录归档；
- [ ] 公开仓 CI 全绿；`pnpm install --frozen-lockfile` 在公开树干净通过；
- [ ] OSS 安装包与内部版在同一台机器共存：appId、数据目录、更新渠道互不读写，卸载互不影响；
- [ ] OSS 版冒烟：安装 → 配模型密钥（或平台登录，PD-074）→ 建项目 → 跑通一个 `examples.public` 示例闭环；
- [ ] Domain pack 获取链路可达：pack-manager 从 industrial-domain-packs 的 Release tarball 拉取并校验成功（前提见 §7 仓库可见性）；
- [ ] 泄密扫描清单（T4）零命中；公开树无任何 `edition=internal` 条目路径；
- [ ] 更新通道指向 OSS 自己的源：OSS 版检查更新不会看到内部版，反之亦然。

## 7. 风险与待决事项

1. **仓库可见性与 pack 通道耦合**：两内部仓库当前为 PUBLIC（headless/chip 等 Release 产物匿名下载的前提）。OSS 用户的 domain pack 获取依赖 industrial-domain-packs Release 可达；若内部仓将来转回 Private，该通道对匿名用户断裂，OSS 版需另配 pack 镜像或子集。转私前必须与 OSS 通道一并决策。
2. **README verbatim 自洽**：导出规则是 README 原样进公开仓。#128 合并前，main 的 README 仍含 CLI 安装指引，此刻导出会产生公开仓死链——首发必须排在 #128 合并之后。
3. **AGENTS.md 版本化转换**：根 AGENTS.md 随公开面发布，其中反引号提及的内部 doc 路径由 #106 按既定转换规则处理（PD-069 2026-10-12 修订许可），导出器实现时逐条登记进审计报告。
4. **正式版双轨对齐**：内部 desktop 正式版与 OSS v1.0.0 必须同一 source SHA，避免「同版本不同行为」。版本映射由 #107 维护，人工不得口头约定。
5. **治理机械留在内部**：架构合约 checker/policy/CODEOWNERS/architecture workflow 不导出（by design）；公开仓的等价边界检查 = `tests/architecture/boundaries.test.cjs` + 派生公开清单 + structure.yml。若公开仓边界检查需要加强，改公开条目后由导出器带回，不在公开仓手工长期分叉。
