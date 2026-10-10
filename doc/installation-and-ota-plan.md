# macOS / Windows 安装、Domain 补装与 OTA 规划

> 状态：2026-10-04 起，桌面构建与首次启动 CI 目标收敛为 macOS Apple Silicon（arm64）和 Windows x64。因缺少 Intel Mac 测试机，暂停 Intel Mac 支持、CI 与安装包发行，详见 [PD-036](product-decisions.md#pd-036暂停-intel-mac-支持)。2026-09-30 的三平台烟测保留为历史记录。本地未签名候选包与原生准备可分别验收；正式签名安装器、公众下载首启和旧版到新版 Core OTA 仍待验收。当前交付优先级仍以 [P0–P3 实施路线](03-implementation-roadmap.md)为准。现有 `headless-v*` 是按 Domain 分发的 CLI 预览归档，不是桌面安装器，也没有 OTA。

## 当前实现与使用

- `packages/pack-manager` 实现签名目录验证、HTTPS 下载、摘要与文件路径检查、跨进程写锁、事务安装、运行中租约、损坏隔离和重装恢复。`scripts/build-pack-distribution.cjs` 从 Chip、PCB、Godot、CAD 现有资源生成独立 `.hpack`；发布时用 `HARNESS_PACK_SIGNING_KEY_FILE` 和 `HARNESS_PACK_SIGNING_KEY_ID` 生成签名目录。
- 1.0.1-beta.1 本地 Apple Silicon 候选包列出全部五个领域，默认提供 Chip、PCB、Godot、CAD 四域多选；CUDA 显示远程服务前提和当前无可安装桌面包的状态，能力中心可补装、更新和修复；没有在线目录也能使用这些随包选项。Desktop 与 CLI 从同一用户目录加载已安装包，共用目录与就绪状态描述；开发模式仍使用仓库里的资源。CLI 提供 `domains list/available/install/update/remove/repair`。在线包列表接受发行公钥验证过的目录；随 Core 提供的可选 Pack 继承应用资源的信任边界，并验证清单固定的归档 SHA-256。
- 当前源码消费端固定 Domain Packs 0.5.2 提交 `f8d0185db5ad668de7e5e3a5bc664dd580dd543c`（含 PCB bench 工具面：89 个 `pcb.bench.*` 工具、vendored actor 与容器网关派发）。PCB、Godot、CAD 按 owner 声明自动下载并准备官方 KiCad 10.0.6、Godot 4.7.2、FreeCAD 1.1.4，用户无需命令或环境变量。界面区分目录未配置／未检查／已连接／不可用，显示下载与安装大小、分阶段进度、可测量的速度与剩余时间，完成后按领域呈现就绪状态和下一步入口。取消等待清理，中断后提示重试，缓存重新校验后复用；空间预估与实际写入前的磁盘检查分开。详见[安装体验](install-experience.md)。
- `electron-builder.config.cjs` 配置 macOS arm64 DMG/ZIP 和 Windows NSIS；主进程通过 `electron-updater` 检查并下载 Core 更新，任务空闲时允许重启安装。`HARNESS_RELEASE_BUILD=1` 要求 Pack 下载源、公钥文件、Core 更新源并强制代码签名；macOS 同时启用公证。CI 配置 Apple Silicon 和 Windows x64 两个目标平台的打包与首次启动检查。
- 模块化安装回归覆盖真实 Chip + PCB 首装、Godot 后补装，以及 Broker/CLI 在安装前后的 Domain 可见性。[2026-09-30 的三平台 CI 打包烟测](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/36691521328)是历史记录，通过签名测试目录和模拟下载完成同一路径；当前只在 Apple Silicon 和 Windows x64 用 `node scripts/smoke-packaged-desktop.cjs --domains` 复跑。该测试验证打包应用的界面和安装链，不等同于安装器、线上 HTTPS 下载源与正式发行密钥的验收。
- 本地构建：在 Apple Silicon 上先执行 `pnpm --filter @industrial-agent-harness/desktop build`，再执行 `node scripts/stage-desktop.cjs dist/desktop-stage-local`，最后用 `apps/desktop/node_modules/.bin/electron-builder --projectDir dist/desktop-stage-local --config "$PWD/electron-builder.config.cjs" --mac dmg zip --arm64 --publish never`。输出在 `dist/desktop-release/`。目录名称每次须新建；Apple Silicon 本地包包含四个可选 Pack，即使没有在线 Pack 目录也可首装；三个托管原生软件首次准备仍需下载官方归档，已完整校验的缓存可复用。
- `desktop-v<apps/desktop/package.json 版本>` 标签触发 `.github/workflows/release-desktop.yml`：构建 Ed25519 签名的 Domain 目录、macOS 签名公证 DMG/ZIP、Windows 签名 NSIS，并在安装包自检成功后创建同名版本 Release，再把文件上传到渠道对应的 GitHub Release 更新源。发布源固定为 `desktop-beta-feed` / `desktop-stable-feed`；先上传版本文件，最后切换 `catalog.json` 和 Core 更新元数据。需配置仓库 Secrets `HARNESS_PACK_PUBLIC_KEYS_JSON_B64`、`HARNESS_PACK_SIGNING_KEY_PEM_B64`、`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_API_KEY_P8_B64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`，以及变量 `HARNESS_PACK_SIGNING_KEY_ID`。签名私钥和公钥 ID 必须配对。1.0.1-beta.1 是本地 beta 候选版本；工作流配置不代表已经发布到该渠道。

当前交付仍为本地未签名候选包。本次环境检查未发现 Developer ID 签名身份，仓库发行 secrets 与 variables 为空；正式签名、公证、公共下载目录、公众 Gatekeeper 首启及真实旧版 → 新版 Core OTA 尚未验收。Core 已内置固定 Kimi Code 2.1.1（Node Server API），不需要另外安装 Python Kimi、Node 或 pnpm。2026-10-06 起的 CAD 安装闭环保留在[本地安装与验收](macos-cad-distribution.md)，2026-10-09 的通用安装层将相同准备入口扩展到 PCB／Godot。Chip MCP 的 Python、RTL 编译工具链及更广 EDA 工具／镜像／PDK 仍需外部准备；CUDA 仍为开发者远程服务配置，不进入自动桌面分发。CI 通过仅证明其实际覆盖的路径，不代表正式发行与 OTA 就绪，也不恢复 Intel Mac 支持。

## 目标与首版范围

以下部分保留发行与 OTA 的规划要求；未在上面的“当前实现与使用”或专项验收中明确实现的项目，不作为本地候选包能力声明。

1. 提供 macOS（Apple Silicon / arm64）与 Windows（x64）的可安装桌面版；每个平台须分别经过真实安装、首次启动和升级测试后才标为支持。Intel Mac 暂停支持，Windows ARM64 待独立验证。
2. 首次安装时可以多选 Domain；以后在应用内安装遗漏的 Domain。同一套 Pack 管理层供 Desktop 和 CLI 使用。
3. 桌面版支持联网检查、下载、验证并应用 Core 与 Domain Pack 更新。更新不能中断正在执行的工业 Action 或覆盖历史工程证据。

模型 API 凭证、PDK 和商业许可仍由用户提供；Apple Silicon 上的 CAD、PCB、Godot 官方原生依赖由应用按固定声明自动准备。某个 Domain 已安装，不等于它的工业执行环境已就绪。健康状态须明确区分“可查看”“可运行 Agent”“工业工具就绪”“需要外部依赖”。

## 用户流程

### 安装与首次启动

下载对应平台的签名安装包 → 安装 Core → 首次启动进入“选择领域”页 → 勾选一个或多个 Domain → 显示各包下载量、安装后占用、支持的平台、功能层级和外部依赖 → 下载、校验、安装、健康检查 → 进入工作台。允许暂时跳过，先使用 Core；创建 Project 时只能选择已安装且可用的 Domain，并可从该页面直接进入补装。

macOS 的 DMG 安装是拖入 Applications，无法提供与 Windows NSIS 一致的安装向导。因此多选流程放在首次启动的应用内准备阶段，Windows 也走相同流程。下载失败时保留成功安装的包与未完成选择，支持重试；离线时可以进入 Core，并在联网后继续。首版可提供经相同验证链的本地 Pack 文件导入，作为无网络部署入口。

### 安装后补装与管理

Settings → Domains 显示“已安装 / 可安装 / 更新可用 / 不兼容 / 需要依赖 / 安装失败”及当前版本、来源和健康检查结果。可多选补装。安装完成后刷新注册表；Project 的 Domain 绑定规则仍是一项目一 Domain。补装不会自动改变已有 Project；若用户为项目切换 Domain，沿用现有清空 Broker Scope、建立新聊天范围的规则。

卸载应先检查是否有 Project 正在使用该 Domain 或 Action 正在运行；被引用时要求先处理项目绑定。卸载只移除 Pack 文件和可重建缓存，不删除 Project、聊天、日志、Artifact、Checkpoint 或用户自己安装的外部软件。全局与项目级 Skill/MCP 开关保留稳定资源 ID，重装后重新生效。

### 更新

启动后及每日检查一次，设置中提供“检查更新”。显示 Core 更新与各 Pack 更新、版本、变化摘要、下载量及是否需要重启。默认后台下载；校验后等待所有受影响的 Session/Action 结束，再激活。Core 更新提示用户重启应用；Pack 更新优先在新会话生效，旧会话使用启动时固定的 Pack 版本。不得在运行中切换其工具、Verifier 或 Scope。CLI/Bench 不在任务执行中自动更新，只提供显式 `harness update` 和版本固定能力。

## 交付物与版本模型

| 交付物 | 内容与边界 | 版本 / 更新 |
| --- | --- | --- |
| Core installer | Electron、共享 Harness 包、固定 Kimi runtime、Broker、Domain Runtime、MCP Gateway、SQLite 访问层和通用 Viewer；不包含大型工业软件 | App 语义版本；整体 OTA |
| Domain Pack | 领域声明、Capability、Skill、MCP/Tool 映射、StateProvider、Verifier、领域 Viewer/Bridge 适配和必要的可再分发资源 | 独立语义版本；按 Domain 补装与 OTA |
| 外部依赖 | 模型凭证、PDK、商业/系统软件、工具镜像及受许可限制的数据 | 由健康检查识别；只对明确可再分发的依赖提供自动安装 |

当前四个默认可选领域沿用 Chip、PCB、Godot、CAD ID；CUDA 保留开发者接入身份。Chip 的 25 工具服务可作为 Pack 一部分安装，但 Python 环境、EDA 镜像、PDK 与项目资源须逐项检查；PCB 的 KiCad Viewer 可以在没有原生 KiCad 的情况下工作，工业动作另行判定；Godot 的 Web Export Viewer 与原生 Godot 安装状态分开展示。不要把现有 Scope 烟测结果写成这些工具已完成工程验证。

Pack 包含 `pack.json`（或等价的验证过的格式），至少声明 `id`、`version`、`manifestSchema`、`coreApi` 兼容范围、`platform/arch`、能力层级、依赖、文件清单、入口、健康检查及迁移版本。Core 与 Pack 的契约版本独立于应用版本；Broker、Runtime 和 Viewer Registry 从已激活的 Pack 发现能力，不在 Core 写死 Chip/PCB/Godot。当前 `packages/domain-skills` 的静态导入、`distribution.json` 过滤和 `package-headless.cjs` 删除其他 Domain 文件的方式只适用于预览包，需迁移到动态注册与安装快照。

发布目录按渠道和平台提供不可变版本及最新版本指针：

```text
channel: stable | beta
core: version, platform, arch, url, size, sha512, releaseNotes
packs[]: id, version, coreApi, platform, arch, url, size, sha256,
         installedSize, capabilities, prerequisites, releaseNotes
```

目录与每个 Pack 的元数据需由发行密钥签名；传输使用 HTTPS，下载后校验签名、摘要、平台和兼容范围。安装器与 Core OTA 使用操作系统代码签名。固定来源提交、锁文件、SBOM 与构建材料，发行物不能来自有未提交改动的工作树。先用现有 GitHub Releases 承载不可变下载文件；更新目录可由同一发布流程生成，未来更换下载源时不改变客户端验证规则。`stable` 与 `beta` 分开，避免预览版自动进入稳定渠道。

## 安装管理层

新建无界面的 Pack Manager，Desktop 和 CLI 共用。它负责目录查询、依赖与兼容解析、下载或本地导入、完整性验证、安装、激活、卸载、健康检查与恢复；Desktop 通过受限 IPC 调用。Pack 文件位于统一的用户级数据目录，工程文件与会话资料仍在原位置。明确管理现有 CLI `~/.industrial-agent-harness` 与 Electron `userData` 的迁移，避免两个入口各有一套已安装 Domain。

每次安装为事务：先解析完整选择及依赖 → 下载到临时目录 → 校验签名/摘要/文件路径与解压大小 → 在隔离目录解包 → 运行只读健康检查 → 原子切换“已激活版本”指针 → 刷新注册表。失败保留旧版本，清理临时文件并记录可恢复原因。Pack 不得在安装阶段执行任意脚本；需要的运行时准备通过受控安装步骤处理。保持前一个可用 Pack 版本，以便回退。安装/更新/卸载同一时间只能有一个写事务；跨进程锁保护 Desktop 与 CLI 并发操作。

Pack 能声明依赖和冲突，但执行时仍由 Broker Scope 与 Domain Runtime 的边界授权。安装签名不等于工具有权读写任何 Project；外部 MCP 和 Viewer 继续按现有项目边界、审批、只读/验证规则运行。损坏或不兼容的 Pack 只影响该 Domain，并提供诊断，不拖垮 Core 或其他 Domain。

## Core OTA 与兼容控制

建议桌面发行链采用 `electron-builder`：macOS 输出签名、公证的 DMG 和配套 ZIP；Windows 输出签名的 NSIS 安装器。`electron-updater` 在主进程检查 Core 新版本、下载和校验，并在应用退出/重启时应用。Windows、macOS 分别在本机 CI runner 构建和签名；不以跨平台交叉构建代替真实平台验收。对关键更新先发 beta，再小比例发布 stable，观察失败后扩大。发布目录与应用中的渠道设置必须一致。

更新发布前需算出“当前所有受支持 Pack 版本 × 新 Core”兼容矩阵。若不兼容，先发布可兼容的 Pack 或把两者作为一个更新计划；不能先更新 Core 导致已装 Domain 消失。数据库迁移必须有版本门槛、备份及失败恢复；历史 Run/Artifact/Verification/Checkpoint 记录不能被 Pack 更新重写。Core 更新失败后仍能启动原版本；若坏版本已经发布，用更高版本修复发布，不能依赖自动降级。

## 实施顺序与验收

1. **前置：P1.3 Loader 与 Pack 契约。** 把静态 Domain 注册迁到可安装目录，保持 Desktop/CLI 一致；用 Test Domain 证明安装和卸载不改 Core 源码，错误 Pack 被隔离。不要跳过当前 Industrial Core Vertical Slice 门槛去先做 UI。
2. **P3-A：单平台最小安装链。** Core 与一个小型测试 Pack 分离打包；完成 Pack Manager 的事务、兼容判定、持久安装状态和首次多选流程。可补装 Chip/PCB/Godot/CAD，项目列表与 Broker 真实反映已安装集合。
3. **P3-B：macOS / Windows 发行。** 两个平台分别完成安装、签名、首次运行、卸载与用户数据保留、CLI 共用 Pack、依赖健康检查；Apple Silicon 与 Windows x64 各用实体或目标架构虚拟机验证。Intel Mac 恢复发行前须有对应测试机并独立完成同等验收。
4. **P3-C：OTA。** 完成 beta/stable 渠道、Core 与 Pack 更新、兼容计划、正在运行的 Session 延迟激活、失败恢复与版本回退；用本地更新源和真实已安装应用做旧版 → 新版测试。

最小验收场景：首次只选 Chip + PCB，稍后补装 Godot；安装中断后重试；离线和错误签名拒绝；安装不兼容 Pack 时不影响其他 Domain；Core/Pack 各升一级并保留项目、聊天与资源开关；更新时工业 Action 正在运行，旧版本保持到任务结束；Pack 回退后 Broker/Viewer/CLI 版本一致；macOS 和 Windows 分别完成真实安装到升级的全程。CI 同时校验包内文件、平台和来源提交，发布门禁必须以打包产物而非开发树执行。

## 仍需在实现前确定的产品参数

- 第一批稳定版 Domain 的实际功能层级及可再分发依赖清单；每个 Domain 需独立标明平台支持。
- 下载源与镜像策略、是否提供企业离线目录，以及长期发行密钥的保管与轮换流程。
- 自动下载的默认策略、数据流量限制和组织管理策略。上面的流程以“后台下载、用户决定何时重启”为首版建议。

## 参考

- [electron-builder v26：Auto Update](https://www.electron.build/v26/docs/features/auto-update/)：macOS ZIP/签名、Windows NSIS、更新元数据与安装后的更新测试。
- [electron-builder v26：多平台构建](https://www.electron.build/v26/docs/features/multi-platform-build/)：签名与原生依赖应在目标平台处理。
- [electron-builder v26：发布配置](https://www.electron.build/v26/docs/publish/)：GitHub Releases 与通用下载源。
