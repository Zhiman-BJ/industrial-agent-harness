# CI 回归与托管环境

入口是 [Harness CI](../.github/workflows/ci.yml)：代码 PR 和默认手动运行执行核心检查；`main` 推送以及手动选择 `full=true` 时执行完整验收。纯文档 PR 仅运行仓库层，独立的 Architecture contract 检查仍按原有规则执行。环境由 GitHub 托管 runner 提供，每个 job 获得独立的干净机器，不需要维护自有虚拟机池。调度修订见 [ADR-008](decisions.md#adr-008核心-pr-检查与完整验收分层)。

| 回归层 | 托管环境 | 核心检查 | 完整验收额外执行 |
| --- | --- | --- | --- |
| 仓库与协议 | Ubuntu 24.04 x64 | 格式、架构边界、Pack/类型兼容、桌面构建、Python Runtime、实际 MCP transport、Icarus 独立 RTL 验证 | — |
| 跨平台基础 | Ubuntu 24.04 x64 / ARM64、macOS 15 ARM64、Windows 2025 x64 | 共享包、CLI、SDK、Viewer 边界、资源与持久化，以及 Chip/PCB/Godot/CAD 四种独立 CLI 包的实际消费 | — |
| 桌面安装 | macOS 15 ARM64、Windows 2025 x64 | 打包应用首次启动、安装引导、工作台、语言切换、并行会话与设置 | 完整 Domain 安装；macOS 真实 CAD 安装、修复与工程任务 |
| Linux 工业闭环与安装 | Ubuntu 22.04 x86-64 | bubblewrap/seccomp、真实 Kimi/Verilator、成功/失败/取消/恢复、打包 Headless Agent 与 bootstrap 回归 | 旧版升级、干净 Chip 安装包、实际安装消费、重复安装及宿主 Docker 执行 |
| 原生工业闭环 | macOS 15 / 26 ARM64 | — | 实际 Seatbelt、Verilator、FreeCAD、固定 Kimi Code、持久化事实、审批拒绝、失败恢复、图像/并行会话、聊天恢复、空闲回收与强制中断，以及真实 CAD 产物的桌面查看 |
| 原生安装消费 | macOS 15 / 26 ARM64 | — | 独立安装 CAD、PCB、Godot，保留签名、原生准备、API/CLI/Desktop 工程任务、独立验证和恢复断言 |

账号登录回归保留在独立的 Account integration workflow；本次不改变它的触发条件。仅改 Desktop 的代码 PR 也执行全部四个平台的基础回归，避免漏掉平台专属的账号存储行为。

需要合并前完整验收时，在 Actions 的 Harness CI 中选择对应分支并勾选完整验收，或运行 `gh workflow run ci.yml --ref <branch> -f full=true`。复用 Desktop/Linux 工作流的其他调用者默认仍执行完整验收。

`ubuntu-24.04`、`ubuntu-24.04-arm`、`macos-15`、`windows-2025` 直接对应原生 OS/架构机器。基础测试还会检查 Node 实际报告的 OS 与架构，避免把交叉编译当作目标平台运行。Node 固定为 24，pnpm 固定为 11.1.3，Python 为 3.13，uv 为 0.11.6，Kimi Code 为 2.1.1；安装遵循已有锁文件。CI 使用本地 HTTP 模型 fixture，不需要模型 API 密钥。

## 门禁与证据

`All checks passed` 按本次核心/完整计划汇总：任何必需层缺席、失败、取消或意外跳过，汇总都失败；只接受调度计划明确省略的层。文件列表获取失败会阻止通过，列表达到 API 上限则执行完整验收。分支保护继续要求 `All checks passed` 和 `Architecture contract`；本次不修改保护规则、架构 checker、policy 或已有原生测试目录。Windows 核心检查仍是必需项。

`scripts/ci-tests.cjs` 记录执行文件、平台、Node 版本、计数与跳过项；零测试、失败、取消、TODO 或未登记跳过都失败。原生闭环和独立 RTL benchmark 不允许跳过，缺少对应门禁要求的 Kimi、Python Runtime、FreeCAD、Verilator 或 Icarus 会失败。回归 JSON 与桌面/原生/CLI 日志通过 Actions artifacts 保留 14 天；失败和取消时也尝试上传已产生的证据。更新 PR 会取消同一 PR 的旧运行。

Portable 测试流设有三分钟的终止信号；测试已通过但进程仍持有未清理的句柄时，也会中止并记录失败文件，避免等待整个 job 到期。Windows 打包步骤限时十分钟，卡住时明确失败。超时与取消仍导致门禁失败。原生工业套件沿用原有时限。完整验收中，`native-installed` 在独立必跑机器上串行执行三个全新托管安装用例，`native` 保留其余工业闭环；两者都不允许跳过，任一失败仍阻止汇总通过。隔离避免大型 app 准备和 Desktop Godot 任务与有明确执行截止的 CAD/RTL 测试争用同一台机器。官方归档缓存仍完整校验后复制到每个独立 store，不复用已经安装的 app。收集报告时只排除 fixture 中的 `installed/.runtime-assets` 原生输入，保留工程输出、聊天、安装报告及 Pack 身份；Actions 原先也不上传该隐藏依赖目录。

有三类明确的覆盖缺口，保留在报告中：

- 基础层允许跳过可选的 KLayout 原生渲染测试；未安装 KLayout 的机器仍执行其余 Viewer 测试。该门禁不证明 GDS 渲染可用。
- Windows 基础层保留两项已有的 POSIX 子进程树清理测试跳过；其余 SDK transport、协议、背压与实际 CLI 消费仍必须执行。这两项需要后续补 Windows 专用验收。
- 协议层允许跳过依赖独立 PCB-bench 源码的那一项测试；仍强制执行官方 MCP transport、参数/范围拒绝、完整大响应和 schema 变化拒绝。私有/外部 PCB 后端与原生工程工具需另行验收。

POSIX 文件权限位断言只在 macOS/Linux 执行，Windows 的 ACL 需单独验收；其他断言保留。Windows archive fixture 使用系统 tar 生成 ZIP，解包使用 runner 自带 Git for Windows 的 unzip。Git attributes 固定源码 LF 并禁止转换按哈希校验的上游 Viewer 资源，避免 Windows checkout 改写发行字节。SQLite fixture 先关闭数据库再删除目录；Linux 子进程清理断言区分已死亡、等待 PID 1 回收的 zombie 与仍然运行的进程。

Linux/Windows 基础回归与 Windows 桌面启动不等于工业 Agent 验收。新增 `native-linux` 门禁和安装消费验证单独覆盖 Linux x86-64；Linux ARM64 与 Windows 工业 Agent 仍未支持。Intel Mac 按 [PD-036](product-decisions.md#pd-036暂停-intel-mac-支持) 暂停支持。签名发行、真实 OTA、真实模型 API 和完整工程任务评测仍属于独立发布验收。

## Apple Silicon CAD 安装门禁

完整验收的桌面安装工作流从实际 DMG 复制 Core，首选 CAD 后由生产 Pack Manager 下载和准备固定官方 FreeCAD。清除开发命令路径，在独立 store 用真实 Kimi Code、审批、建模、尺寸修改、独立回读和 OCCT Viewer 验证，再测试损坏修复与重启。模型响应来自本地受控服务，不评价模型推理质量。证据包括 `acceptance.json`、`restart.json`、界面截图与实际工程输出，排除大型 app 和依赖缓存。原生 CAD 失败不能降级为仅检查注册或跳过。详见 [分发说明](macos-cad-distribution.md)。

## 本地复现

先执行 `pnpm install --frozen-lockfile`，再按需要运行：

```sh
pnpm run test:ci -- portable
pnpm run smoke:ci-packages
pnpm run test:ci -- benchmark
pnpm run test:ci -- transport
KIMI_EXECUTABLE="$PWD/apps/desktop/.venv-kimi/bin/kimi" pnpm run test:ci -- native
KIMI_EXECUTABLE="$PWD/apps/desktop/.venv-kimi/bin/kimi" pnpm run test:ci -- native-installed
```

`benchmark` 需要 `iverilog` 和 `vvp`；`transport` 需要 Chip/PCB 锁定 Python 环境；`native` 需要 Apple Silicon、Verilator、FreeCAD 1.1.4、Chip Python 环境与固定 Kimi，准备步骤见 [Industrial Core workflow](../.github/workflows/industrial-core.yml)。`native-installed` 需要固定 Kimi、签名 Pack 构建和独立 CLI/Desktop payload，以及官方原生归档；每个 fixture 经生产安装层独立解包、签名检查和版本探测。CLI 冒烟只清理自身的 `dist/ci-headless` 临时目录，之后从独立临时工作目录运行四个领域包，检查领域绑定、资源、共享配置与禁用策略。

## 参考来源

参考 DeepSeek Harness 的分层 job、实际目标平台消费、必需检查汇总和禁止必需测试静默跳过的做法；上游实现截至 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`：

- [CI 与 all-checks-passed](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.github/workflows/ci.yml)
- [原生 SDK 包消费测试](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.github/workflows/build-exe-for-python-sdk.yml)
- [Sandbox 测试门禁](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.github/workflows/sandbox.yml)
- [GitHub 托管 runner 的 OS/架构](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

本仓库使用自己的 Node 测试与现有工业契约，未复制上游的特定服务、密钥、Windows 观察项或自托管环境。

FreeCAD 首批 native suite 和实际 Electron CAD Viewer 加入 macOS arm64 原生门禁。CI 下载并校验官方 FreeCAD 1.1.4 DMG 的固定 SHA，只读挂载提供 `freecadcmd`；缺少依赖会失败。配方/STL/文件边界及 CAD CLI 包的 Scope 检查加入四平台 Portable 层。详见 [FreeCAD 接入与回归](freecad-domain-pack.md)。

FreeCAD 1.1.4 的原生 CAD/RTL/Kimi 综合门禁覆盖 `macos-15` 和 `macos-26` arm64；四平台 Portable 与 Desktop macOS 打包仍固定 `macos-15`。FreeCAD 的配置、数据与缓存目录在每次 Action 内独立创建和验证，确保全新托管环境无需预先启动桌面 FreeCAD。

2026-10-05 共享底座：四平台 Portable 覆盖文件边界和真实 stdio/HTTP/SSE；macOS arm64 与 Linux x86-64 native 强制真实 Kimi 的空工程→编辑→通过→失败→修复及外部 MCP 审批/图片/禁用。独立 Chip/PCB 包和 Linux 安装消费者重复闭环，Linux 实际 Docker 镜像另验共享任务。缺少必需依赖不跳过。

2026-10-07 修复门禁：公共包回归新增分步文本/思考流、真实子 Agent 审批批准/拒绝/取消、
MCP 同聊天状态连续性/跨聊天隔离/过期失败、旧 SSE 断连拒绝自动重建与清理、工作区筛选和增量哈希、审批输入冻结、
无模型环境诊断。桌面安装 job 增加实际 UI 和语言切换自测，保留截图与日志。
Linux 候选安装从公开 preview.4 升级：旧包创建真实聊天/原生上下文、模型配置、MCP 注册及
项目开关，新包续聊，验证旧历史/原生文件保留、上下文版本分段和新段跨进程继续。
升级验收报告由 scripts/smoke-cli-upgrade.cjs 生成；CI 结果以对应 commit 的运行记录为准。
子问题仅验事件转发协议；固定内核 coder Profile 未开放 AskUserQuestion，不声称该原生路径可用。
