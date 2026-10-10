# Internal/OSS 双版本产品边界与公开清单

- 日期：2026-10-10
- 状态：已确定（待定案事项见文末清单）
- 来源：[#101](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/101)、[#100](https://github.com/Zhiman-BJ/industrial-agent-harness/issues/100) 双仓库 Epic、2026-10-10 用户产品决定
- 机器清单：[architecture/editions.json](../architecture/editions.json)（本文档的人类可读配套；冲突时以清单与校验器为准）

本文档定义 industrial-agent-harness 内部开发仓库与外部开源版本（下称 OSS edition）的产品边界、公开清单、机器校验规则和导出约定。内部仓库保留现有名称、完整代码与开发历史；外部仓库只接收经清单批准的版本快照。外部仓库名称、地址、默认分支与许可证待用户定案前，一切真实发布被发布门禁显式阻断。

## 1. Edition 定义与默认公开面

- **internal edition**：本仓库（私有）。包含全部功能与开发历史，是唯一的开发与 PR 落地点。
- **public（OSS）edition**：由 #106 导出器从固定 source ref 生成的版本快照。只包含清单标记为 `public` 的模块。

默认公开面（PD-069）：**已实现且可验证的核心任务流程、必要的错误/状态/记录、选定 Viewer 和扩展接口**。以下四类能力不进入公开源码或发行物：

1. Debug 面板与完整诊断（提示词、原始 SDK 事件、完整工具参数/返回、上下文快照、诊断浏览器、`inspect-log`）；
2. 轨迹录制与 Demo 重放（#103–#105 新增能力）；
3. 内部文档中心与 `doc/` 内部文档；
4. 内部发行流水线与治理机械（架构合约 checker/policy、发行脚本、内部 release 工作流与记录）。

Domain Packs 按既有外部仓库（industrial-domain-packs）所有权消费固定版本，不在本清单中展开领域实现，也不自动把领域内容纳入公开面。

## 2. 产品矩阵

下表是 `architecture/editions.json` 的人工摘要。每个模块的权威字段（路径、入口、依赖分类、公开说明来源、必需测试、决策状态）以清单为准；校验器保证两者不一致时 CI 失败。

| 模块 ID | 内容 | Edition | 依赖分类 | 决策状态 |
| --- | --- | --- | --- | --- |
| `apps.desktop` / `apps.cli` | Desktop 与 CLI 适配器（Debug/Logs、inspect-log 除外） | public | adapter | 已确定 |
| `packages.contracts` | 工业事实/状态/运行/工件/验证/检查点契约 | public | canonical-contracts | 已确定 |
| `packages.harness-core` / `capability-broker` / `domain-runtime` / `harness-application` | 共享 Core、Broker、通用 Runtime、共享任务 API | public | core-runtime | 已确定 |
| `packages.agent-kimi` | Kimi 固定内核接入（诊断日志文件除外） | public | agent-kernel | 已确定 |
| `packages.pack-manager` / `domain-skills` / `domain-mcp` | Pack 消费、默认 Skill/MCP 声明（冻结领域快照除外） | public | pack-consumption | 已确定 |
| `packages.computer-use-bridge` | GUI 横切插件 | public | cross-cutting-plugin | 已确定 |
| `packages.viewer-core` / `viewer-builtin` | 只读 Viewer 内核与内置 Viewer | public | viewer | 已确定 |
| `packages.sdk` | Node SDK 与 stdio JSON-RPC | public | adapter | 已确定 |
| `examples.public` | 示例工程（Sobel、bench 烟测等） | public | examples | 已确定 |
| `tests.public-core` | 核心闭环/共享契约/传输/会话等测试 | public | meta | 已确定 |
| `scripts.dev-tooling` | 开发工具（含 release-notices：公开许可证物料测试消费） | public | meta | 已确定 |
| `github.ci-public` | 公开 CI 脚手架（ci/structure/industrial-core/industrial-linux） | public | meta | 已确定 |
| `internal.diagnostics.*`（4 条目） | 诊断日志、读取器、Debug 面板、inspect-log、agent-log selftest | internal | diagnostics-internal | 已确定（隔离由 #102 完成） |
| `internal.docs` | `doc/` 内部文档 | internal | docs-internal | 已确定 |
| `internal.releases` | 内部发行记录 | internal | release-internal | 已确定 |
| `internal.governance` | IH-ARCH-001 治理机械、AGENTS.md、policy | internal | governance-internal | 已确定 |
| `internal.github-release-workflows` / `internal.scripts-release` | 现行发行流水线（含内部耦合，#106/#108 重建公开版） | internal | release-internal | 已确定 |
| `internal.domain-frozen-root` / `internal.domain-skills-frozen` | IH-ARCH-001 冻结领域快照（当前已随迁移删除，前缀保留防回归） | internal | docs-internal | 已确定 |

## 3. 机器清单与校验器

清单文件：`architecture/editions.json`（schemaVersion 1，manifestId `IH-EDITIONS-001`）。校验器：`scripts/check-editions-manifest.cjs`，npm 入口 `pnpm test:editions`，并随 `pnpm test:architecture` 的架构套件运行。

每个条目字段：`id`（稳定模块 ID）、`edition`（public/internal）、`paths`（文件或目录前缀；同一路径不得被两个条目声明）、`entry`（入口）、`dependencyClass`、`publicStatementSource`（public 条目必填，指向公开文件及其锚点）、`requiredTests`、`decisionStatus`（decided/pending）、`isolation`（internal 条目必填）。

校验规则（dev 门禁，本地与 CI 常跑）：

1. **schema 健康**：字段类型、枚举、路径安全（拒绝绝对路径/`..`/反斜杠）、路径唯一归属。
2. **全仓覆盖**：仓库内每个文件必须命中至少一个条目（最长前缀优先）。**新增未分类路径（例如新的顶层目录、新的根文件）直接失败**——这就是“新增未分类公开候选会使校验失败”。
3. **依赖方向**：public 文件不得 import 解析到 internal 条目的路径。`isolation.status=enforced` 的条目出现任何引用即失败；`planned` 条目（当前诊断四条目，台账 6/1/1/3）记录 `legacyReferences` 上限，**只减不增**，#102 完成组合层隔离后归零并转为 enforced。
4. **公开说明可溯**：`publicStatementSource` 指向的文件必须存在、属 public 条目，且锚点文本真实出现。
5. **必需测试存在**：条目声明的测试文件必须在仓库中存在。

release 门禁（`--gate release`，#106 导出与真实发布必跑）：dev 门禁全部规则，加上——

- `release.externalRepoName/externalRepoUrl/externalDefaultBranch` 任一为空 → 阻断（本地开发与导出演练不受影响，真实发布明确失败）；
- `release.license` 为 `pending` → 阻断（不得替用户选择许可证）；
- 任何条目 `decisionStatus=pending` → 阻断；
- 任何 `planned` internal 条目仍有活引用 → 阻断（#102 隔离未完成不得导出）。

## 4. 导出器固定输入/输出约定（#106 契约）

导出器（#106 实现）是清单的唯一下游消费者，输入输出固定如下：

**输入**（全部固定，不读取未列出的状态）：

1. source ref：单一 Git commit SHA（导出物必须可从该 SHA 完全重放）；
2. 清单版本：`architecture/editions.json` 的 `schemaVersion` + `manifestId`；
3. 公开配置：清单 `release` 块（外部仓库标识、许可证）。

**输出**：

1. 公开树：仅含 `edition=public` 条目路径的文件快照；internal 条目路径与 `pathsMayBeAbsent` 目录一律排除；
2. 公开 metadata：从清单**派生**的只含 public 条目的清单（内部条目 ID/路径不进入公开仓库，避免泄露内部结构）；
3. 私有审计报告：导出文件清单、来源 SHA、排除规则命中记录——只留在内部，与公开 metadata 严格分离。

**变换规则**（导出时执行的确定性变换，逐条登记在导出报告）：

- `AGENTS.md` 不导出；公开仓库的 agent/contributor 指引由 #106 生成（内容仅来自公开面行为）；
- `README.md`/`README.zh-CN.md`、LICENSE、THIRD_PARTY_NOTICES.md 原样保留（第三方合法归属不得抹除）；
- 根 `package.json`/workspace/lockfile 按公开包集合裁剪，lockfile 重新生成且可复现；
- 每版导出在公开仓库形成单条整理后的发布提交，不携带内部提交历史（#107 执行）。

## 5. OSS 等价公共边界检查

内部 checker（`scripts/check-architecture-contract.cjs`）、`architecture/policy.json` 与 `doc/architecture-contract.md` 属 IH-ARCH-001 治理机械，不导出、不削弱。OSS 获得的等价公共边界检查：

| 内部规则 | 公开等价物 | 状态 |
| --- | --- | --- |
| 适配器不互相 import、CLI 不依赖 Electron/Viewer UI | `tests/architecture/boundaries.test.cjs`（公开）+ editions 校验器依赖方向检查 | 已可用 |
| Core 不 import agent 内核/adapter/具体领域 ID | `tests/architecture/boundaries.test.cjs` | 已可用 |
| 仓库文件全分类、public 不引用 internal | `scripts/check-editions-manifest.cjs` + 派生公开清单 | 本次交付 |
| 结构脚手架（README/LICENSE/包清单） | `.github/workflows/structure.yml`（公开） | 已可用 |
| 治理哈希/冻结基线保护 | 不适用（公开树无治理机械；内部检查继续在内部仓库强制） | 按设计不导出 |

## 6. 安装归属、应用身份与迁移策略（#108 输入）

本节是 #108 的决策输入，#109 只执行与验证：

1. **既有安装版归属**：当前所有已安装桌面版（1.0.1-beta.1 及更早）与无 UI Core/Chip Release 均属 internal edition，不迁移到 OSS 渠道。
2. **应用身份**：OSS edition 使用独立的应用 ID、 productName、数据目录与更新渠道（#108 接通）；两个 edition 可在同一机器共存，互不读写对方数据。
3. **用户数据**：不自动迁移。用户主动切换 edition 时按普通新安装处理。
4. **下载/更新地址**：内部版现有下载与更新地址继续由内部渠道服务；OSS 版地址由 #108 配置。旧地址的下线/重定向与已公开历史的影响由 #109 统一处理。
5. **应用身份/渠道配置接口**由 #102 的内部扩展接口预留，避免诊断、文档、录制回放各持一套配置。

## 7. 待用户定案事项

以下事项登记为 pending，在清单与发布门禁中显式阻断真实发布，不由实现 agent 代为定案：

1. OSS 仓库名称、URL、默认分支（当前为空 → release 门禁阻断）；
2. 许可证选择（当前 `pending` → release 门禁阻断；仓库现有 LICENSE 为 MIT，公开版是否沿用需用户确认）；
3. 公开发布节奏（#100 建议双周检查发布资格、紧急修复加急，仅流程建议，待确认）；
4. Core Vertical Slice 之外是否有新增公开候选面（如 BenchTop/PCB 相关能力是否入公开清单，另行立项）。
