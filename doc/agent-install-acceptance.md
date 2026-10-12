# 安装与运行环境验收 Agent 任务书

你是本次独立 QA agent。你的任务是实际执行下面的验收，保存可复查证据，报告缺陷和未覆盖范围。不要只审查代码、复述已有 QA 记录或生成测试计划后结束。

本文针对 Harness PR #130 与 Domain Packs PR #20 的 runtime distribution v2。先以当前代码和实际界面确认行为，再执行测试；发现本文入口与目标版本不符时，记录差异并在同一职责层查找现有入口，不要伪造测试通过。

## 1 目标与完成条件

回答以下问题，并分别给出证据：

1. 新用户能否安装四个领域 Pack，且不会被隐式要求下载大型软件、安装 Docker 或连接远端？
2. 缺依赖时是否准确提示，已有软件是否能发现、验证、关联并真正执行？
3. 显式准备软件或镜像能否完成，失败、取消、退出、重试是否可恢复？
4. 关联是否按全局/项目作用域持久化，错误配置是否阻止执行而不损坏旧环境？
5. 原生、容器和远程路径分别实际覆盖了哪些领域，哪些仍然失败或受阻？

只有所有适用必测项都获得终态、报告和证据保存后，才能结束任务。缺凭据、机器锁屏、服务不可达等只阻塞相关项；继续完成独立项目。不得因部分测试失败就停止整个验收，也不得反复重跑同一个失败直到偶然通过。

本任务授权范围是测试和生成证据。可创建临时工程、隔离配置和构建产物，使用已有合法凭据执行指定测试，以及显式准备本文要求的测试运行环境；遵守所在环境的审批规则。默认不修产品代码、不改测试断言、不更新锁文件、不提交/推送/合并/发布。发现缺陷先保存最小复现，修复需另开明确工作项。

## 2 定位仓库与固定身份

同机工作目录：

```text
HOST_REPO=/Users/roger/.codex/.chatgpt-projects/g-p-6a97bb9a4c6c8191a842ad700c51e704/implementation/industrial-agent-harness-runtime-v2
OWNER_REPO=/Users/roger/.codex/.chatgpt-projects/g-p-6a97bb9a4c6c8191a842ad700c51e704/implementation/industrial-domain-packs-runtime-v2
```

若在另一台机器执行，使用同名仓库的本地路径；不要假设以上路径存在。

| 对象 | 当前验收基线 |
| --- | --- |
| Harness | https://github.com/Zhiman-BJ/industrial-agent-harness/pull/130 |
| Harness commit | 测试时实际 Harness PR head（记录完整 commit，不沿用旧基线） |
| Owner | https://github.com/Zhiman-BJ/industrial-domain-packs/pull/20 |
| Owner commit | `2036b599318267b7a28775ff614915da21ad6fcf` |
| Owner package | `0.7.0` |
| Pack 目录版本 | Chip `0.7.0`，PCB `0.3.0`，Godot `0.2.3`，CAD `1.1.4-pack.10` |

两个 PR 是 stacked PR，不以 main 代替对应分支。首先读取两个仓库的 `AGENTS.md` 与架构合同，记录 `git status --short`、HEAD、分支和 lockfile 中 owner pin。不要清理用户改动、reset 现有 checkout 或覆盖其他 agent 工作。目标版本有变化时记录实际 commit，说明与本文基线的差异，禁止把旧报告算作新版本证据。

优先阅读 Host：

- `doc/runtime-distribution-v2.md`
- `doc/qa-runtime-distribution-v2-20261012.md`
- `apps/desktop/QA.md` 与 `apps/desktop/AGENTS.md`
- `doc/dependency-plan-review-20261012.md`，注意此文件中的 Plan/Doctor 是提案
- `packages/pack-manager/src/runtime-environments.cjs`
- `apps/desktop/src/components/RuntimeEnvironments.tsx`

旧文档可能仍描述“安装 Pack 后自动下载软件”。本轮以 v2 文档、固定 manifest 和当前实现为准，并将冲突记录为文档缺陷。

## 3 隔离与证据目录

在本次任务独有目录保存所有证据，例如 Host 下 `dist/qa-agent-install-<UTC时间>-<随机后缀>/`。建立：

```text
manifest.json          # 源码、应用、平台、软件、镜像及目录身份
report.md              # 最终结论与缺陷
cases.json             # 逐项机器可读结果
commands/              # 命令、工作目录、退出码、stdout、stderr
screenshots/           # 当前候选实际界面
cases/<case-id>/       # 独立配置、测试输入副本、日志和产物
```

要求：

- 每个测试流使用新的 Pack store、config directory、Electron userData 和项目副本，不能共享本次安装状态。不要复用旧 QA 的成功收据。
- 用 `INDUSTRIAL_HARNESS_PACK_STORE` 隔离 Pack/托管资产，用 `INDUSTRIAL_HARNESS_CONFIG_DIR` 隔离配置，用 `--user-data-dir` 隔离 Desktop 数据；逐项核对其他实际写入位置。
- 常规 Desktop 聊天日志仍可能写到 `~/.industrial-agent-harness/logs/`；上述三个参数不代表完全隔离。只收集属于本次项目的记录，不复制无关聊天。CLI 可显式指定 `--log-dir`、`--state-dir`、`--chat-dir`。
- 不修改 HOME、CODEX_HOME，不删除现有配置，不卸载/移动 `/Applications` 中的工作软件，不清空已有 Docker 镜像或全局缓存。需要破坏性条件时用测试副本或专用环境。
- 新 store 不等于全新电脑：记录 `/Applications`、用户应用目录、相关环境变量、已有托管下载/镜像缓存的影响。无法排除缓存则标为缓存/热路径，不算冷下载。
- 每条命令独立记录退出码，避免管道或最后一条命令掩盖失败。长任务合理等待并持续报告进展；无进展时先保存进程/网络/错误证据，再处理本任务拥有的进程。
- 不记录凭据值，不将凭据文件、完整加密连接存储、客户项目或无关日志纳入证据。

## 4 分阶段执行

### 阶段 A 身份与基础回归

记录 macOS/CPU、Node、pnpm、Go、Docker CLI 和 daemon、已有厂商应用及版本。主验收平台为 macOS ARM64；其他平台只能报告本次实际执行的范围。

先检查工具版本是否符合根 `package.json`。依赖未安装时用固定锁安装；不要改 dependency pin。以下命令在 Host 根运行，每条分别落日志：

```sh
pnpm install --frozen-lockfile
pnpm test:architecture
pnpm test:architecture-contract
node scripts/check-pack-release.cjs
pnpm --filter @industrial-agent-harness/pack-manager test
pnpm --filter @industrial-agent-harness/domain-runtime test
pnpm --filter @industrial-agent-harness/harness-core test
pnpm --filter @industrial-agent-harness/harness-application test
pnpm --filter @industrial-agent-harness/cli test
pnpm --filter @industrial-agent-harness/desktop test
pnpm --filter @industrial-agent-harness/desktop build
```

Owner 根运行其已有锁定依赖安装方式，再执行：

```sh
npm test
npm run lock:check
npm run test:architecture-contract
```

Go 环境可用时，在 Owner `mcp/environment-probe` 执行 `go test -race ./...`。记录未执行原因，不能由 Go 交叉编译推断目标平台原生软件可用。

有 GitHub 权限时读取两个 PR 当前 checks；按实际 head commit 归类。历史已知 Harness CI 失败包括 portable skip gate、CUDA installed integration 和 Desktop MCP selftest。读取最新日志确认是否仍复现，不把一切归因于 CI 环境。禁止放宽架构 policy 或 skip gate。

### 阶段 B 现有自动 UI 回归

先构建 renderer，再运行 selftest；旧 `dist/` 不是当前代码证据。下面是经仓库文档确认的入口，执行前将路径变量设为本次绝对路径。每个入口使用不同目录，窗口相关测试串行运行。

```sh
INDUSTRIAL_HARNESS_PACK_STORE="$QA_ROOT/env/packs" \
INDUSTRIAL_HARNESS_CONFIG_DIR="$QA_ROOT/env/config" \
INDUSTRIAL_UI_SCREENSHOTS="$QA_ROOT/env/screenshots" \
pnpm --filter @industrial-agent-harness/desktop exec electron . \
  --runtime-environments-selftest --user-data-dir="$QA_ROOT/env/user"
```

```sh
HARNESS_INSTALL_EXPERIENCE_REPORT_DIR="$QA_ROOT/install/evidence" \
INDUSTRIAL_HARNESS_PACK_STORE="$QA_ROOT/install/packs" \
INDUSTRIAL_HARNESS_CONFIG_DIR="$QA_ROOT/install/config" \
pnpm --filter @industrial-agent-harness/desktop exec electron . \
  --install-experience-selftest --user-data-dir="$QA_ROOT/install/user"
```

正常退出中断准备另跑一轮，使用全新的 `quit` 目录，在安装 selftest 命令上额外设置 `HARNESS_INSTALL_EXPERIENCE_QUIT_TEST=true`。

必须读取每次产生的 JSON 报告、退出码与截图；不能仅凭进程退出认定成功。这一阶段使用签名 fixture 应用/受控下载和服务，只算交互与生命周期回归，不算厂商软件冷下载或真实 GPU 验收。fixture 目录只提供一个测试包时，其他领域的 Not offered 不代表实际发行目录缺包。

### 阶段 C 真实发行目录与 packaged app

优先使用身份可验证的当前候选应用。同机历史候选位置是 Host 下：

```text
dist/desktop-release/mac-arm64/Industrial Agent Harness.app
```

不要因为路径存在就认定它来自当前 HEAD。记录其版本、资源 pin、实际 bootstrap 目录和校验身份；无法建立构建来源时，按仓库发行流程重新构建到新目录，或将 packaged 验收标阻塞。保留未签名/未公证事实。

需要重建 Pack 目录时，Host 中已有入口：

```sh
node scripts/build-platform-probe.cjs "$QA_ROOT/platform-probe"
HARNESS_PLATFORM_PROBE_INDEX="$QA_ROOT/platform-probe/platform-probe-index.json" \
node scripts/build-pack-distribution.cjs "$QA_ROOT/catalog"
```

以上是维护者构建步骤，不是用户安装必需步骤。构建输出不得覆盖其他任务产物；新输出目录不能预先存在。后续打包若需要 probe，继续传入这份独立的 `HARNESS_PLATFORM_PROBE_INDEX`，不要使用其他任务遗留组件。

真实目录回归入口：

```sh
HARNESS_RELEASE_CATALOG_BUNDLED_DIR="$QA_ROOT/catalog" \
HARNESS_RELEASE_CATALOG_REPORT_DIR="$QA_ROOT/catalog-ui/evidence" \
INDUSTRIAL_HARNESS_PACK_STORE="$QA_ROOT/catalog-ui/packs" \
INDUSTRIAL_HARNESS_CONFIG_DIR="$QA_ROOT/catalog-ui/config" \
pnpm --filter @industrial-agent-harness/desktop exec electron . \
  --release-catalog-selftest --user-data-dir="$QA_ROOT/catalog-ui/user"
```

这条源码 Electron 命令不能替代 packaged 验收。还必须在真实 `.app` 中验证随附目录：可使用同一 selftest 的 packaged 入口（先读实现确认参数），以及下面的普通启动 UI 路径。不要替换应用的 bootstrap 目录来假装发行包齐全。

用所在环境允许的桌面自动化工具，在普通启动、无 selftest/fixture transport 的候选 `.app` 中走一遍：首次选择四域 → 安装 → 能力中心 → 缺失/已有软件检测 → 显式关联或准备 → 项目内运行 → 正常退出与恢复。屏幕锁定只阻塞这部分，继续 headless 测试。遵守当前环境的 UI 工具要求，不能绕过工具限制或系统安全提示。

### 阶段 D 真软件与真下载

测试工程从固定 Owner 提交导出到本次工作目录；不要在源样例中运行：

| 路径相对 Owner 根 | 用途 |
| --- | --- |
| `packs/godot/examples/structural/` | Godot 场景及脚本 |
| `packs/pcb/examples/mounting-board/` | KiCad 板级原生验证 |
| `packs/chip/examples/managed-rtl/` | RTL lint 与仿真 |

CAD 与 PCB design 容器测试使用空目录即可。Host 的 `examples/pcb-led` 是预览样例，`examples/chip-sobel/outputs` 是历史产物，不用它们声称工程验证通过。

已有 Godot 的共享 Runtime 原生测试入口（Host 根）：

```sh
HARNESS_TEST_NATIVE_ENVIRONMENTS=1 \
HARNESS_TEST_PLATFORM_PROBE="$QA_ROOT/platform-probe/darwin-arm64/industrial-environment-probe" \
node --test packages/harness-core/tests/runtime-environment-native.test.cjs
```

它使用真实已有 `/Applications/Godot.app`，但自行装配测试 Pack，不能代替真实发行 Pack 的普通 UI 路径，也不是冷下载证据。

CUDA 不属于本次产品验收，不需要真实 GPU、Compiler/Evaluator 服务或配对凭据。独立历史 MCP 测试只作为回归诊断，不替代 T29–T31 的当前目录与文案检查。

对 KiCad/FreeCAD/Godot 的冷下载必须从当前产品 `Prepare managed environment` 进入，分别记录来源、字节、缓存条件、耗时、取消和最终错误。不得先在浏览器下载或复制已安装应用，再称托管冷下载成功。用户自行官网下载属于另一用例。历史总超时和无断点续传仍须真实记录。

## 5 必须逐项登记的 36 个验收用例

下面每行都需要结果；注明 P1 的是补充项，其余为适用范围内必测。同一项要求多软件/多模式时用 `T12.godot`、`T12.freecad`、`T12.kicad` 等子 ID 分开登记。父项仅在全部适用子项通过时通过。

| ID | Agent 要执行的操作 | 通过判据或证据要求 |
| --- | --- | --- |
| T01 | 普通启动身份已确认的 packaged app | 记录版本/来源/OS/CPU，首次启动成功；系统拦截单独报告，不能声称公众 Gatekeeper 已验 |
| T02 | 核对实际随附四域，逐个及多选 | 四域可安装，版本符合目录；真实目录缺包报失败 |
| T03 | 新 store 安装四域，比较环境准备事件与资产前后清单 | 仅 Pack 安装，不隐式下载厂商软件/拉镜像/部署远端；不得仅凭传输快下结论 |
| T04 P1 | 在独立条件下离线装随附包 | Pack 可离线装；不延伸为软件可离线准备；不要断开用户正在使用的网络 |
| T05 | 三种原生方式逐一测试未找到软件 | 明确缺失，不下载、不自动关联；机器已有软件时 fixture/无效路径只算受控缺失测试 |
| T06 | 检测并关联已有 Godot 4.7.2、FreeCAD 1.1.4、KiCad 10.0.6 | 校验路径/版本/适用签名；检测不保存，Check and save 后关联且不重复下载 |
| T07 P1 | 选择自定义路径中的合法测试应用副本 | 指定副本验证后可保存；取消选择不改原关联 |
| T08 | 选择错误产品或不兼容版本 | 拒绝新关联并保留旧有效环境，执行能力不得错误开放 |
| T09 P1 | 在安全隔离条件下放置多个兼容候选 | 要求明确选择，不静默挑选；无法构造真实条件时分清 fixture 覆盖 |
| T10 | 有效关联后尝试保存失败的新选择，再恢复有效选择 | 复验 K1 修复：旧有效关联保留，最近失败显示红色失败且覆盖旧 Ready；恢复成功才显示绿色就绪，不预填通过 |
| T11 P1 | 三种原生方式打开 Official installation page；可行时自行安装兼容版本再检测 | 官方产品/版本入口正确；点击链接不等于安装，返回后需检测保存 |
| T12 | 三种原生方式分别真实托管冷下载 | 成功后保存环境且执行 T21/T23/T24；记录无缓存证据、源、字节、耗时。超时按失败，不用热安装替代 |
| T13 | 真实软件下载中取消，再重试 | 取消有终态，锁和本任务临时数据可清理，Pack/旧环境保留，再次准备可运行 |
| T14 | 下载中正常退出 app，再重开 | Pack/项目保留，无永久准备状态/死锁，重试可运行；不能用 kill -9 替代正常退出 |
| T15 | 在本任务可控传输条件制造网络失败，再恢复 | UI 不假成功，可取消/明确失败并重试；记录重新下载与续传区别，不破坏全机网络 |
| T16 P1 | 使用预设容量受限的专用测试存储 | 空间不足明确失败，Pack/旧环境保留；无安全条件标阻塞，禁止填满系统盘 |
| T17 | 保存全局及项目关联，正常退出重开 | 关联和路径持久化，身份变化不能沿用失效 Ready |
| T18 | 两同域项目分别设置默认/覆盖；检测中切项目；恢复默认 | 无异步状态串项目，恢复默认不删除应用 |
| T19 | Pack 已装但环境未就绪时浏览与请求执行 | 浏览可用，执行明确拒绝，无静默下载/远端回退；没有模型时只报告 gate 层覆盖 |
| T20 | 已关联的专用软件副本路径失效，再恢复 | 执行前拒绝失效身份，历史证据保留，重新关联可恢复；不移动工作应用 |
| T21 | 对 structural 的 main.tscn 实际调用 godot.scene.verify，12帧，Box.mesh_size=[2,3,4]、position=[1,2,3] | 原生版本、帧读回、产物、Action/Verification 均存在且通过 |
| T22 | 不改场景，以 [9,9,9] 错误尺寸再次核验，然后恢复正确预期 | 错误预期必须失败并留证，不允许自动改输入凑通过 |
| T23 | 空 CAD 项目用 FreeCAD 从原点建40×20×5 mm板，在全局XY(10,10)沿Z打半径2 mm通孔 | cad.freecad.build 实际执行；独立回读边界[40,20,5]、体积3937.168146928204 mm³、实体1；不能仅看预览 |
| T24 | mounting-board 的 board.kicad_pcb：pcb.kicad.verify 验40×30 mm、H1(10,10)、H2(25,15)、旋转0、maxWarnings=2 | 真实DRC/pcbnew独立读回，零错误/未连接项，警告如实；不外推ERC或制造资格 |
| T25 | 容器方式在 Docker缺失/daemon不可达时准备或执行，再恢复服务 | Pack 可装；实际需要daemon时明确失败，不把镜像收据当服务就绪；不停止用户在用的daemon |
| T26 | Chip显式准备固定镜像，对 managed-rtl 按 eda.yaml 跑lint和仿真 | 实际容器、镜像身份、本轮日志与验证；不使用历史产物，不外推PDK流程 |
| T27 | 空PCB项目选择design容器，调用 pcb.design.new_project(width_mm=40,height_mm=30,layers=2)，再project_status读回 | 实际容器执行、spec.json和尺寸层数匹配；not_run操作收据不得说成工程验证通过 |
| T28 | CAD DXF容器生成原点起40×20 mm闭合矩形drawing.dxf，并实际回读 | 本轮工具、DXF与回读匹配；无需FreeCAD/AutoCAD；聊天代码不算执行 |
| T29 | 新 store 普通启动，检查首装、能力中心与项目领域选择 | 当前只有 Chip、PCB、Godot、CAD 四个领域；无 CUDA 产品入口、六项远程配置表单或隐式服务动作 |
| T30 | 隔离 store 预置历史已装 CUDA 与第三方自定义领域，再打开目录及重启 | Owner withdrawnDomains 抑制历史 CUDA 用户入口；第三方领域保留，不用默认目录白名单；不删除历史工程或证据 |
| T31 | 逐域检查卡片、一行用途、折叠依赖和四种状态，切换 native/container | 边框清晰，默认折叠；状态命名实际缺项，绿就绪/黄缺失/红失败/中性未检查；Docker 仅要求 Chip、PCB design、CAD DXF 容器路径，不要求 Pack 安装或 Godot/FreeCAD/有限 KiCad 原生检查 |
| T32 P1 | 中文/英文、浅色/暗色、常规/640×480及键盘操作 | 检测/准备/取消/错误可读可达，无关键按钮遮挡，内部术语造成阻碍应报缺陷 |
| T33 | 测试Pack移除再装，比较用户软件/工程/历史 | 不删用户应用与项目，领域资源恢复后状态真实 |
| T34 P1 | 专用在线测试目录实际传输Pack时取消并重试 | 与软件准备取消分开；无半包成功、旧包保留、重装可用；小包未触发则不能算测过 |
| T35 | 专用两个签名版本更新时传输/校验失败，再有效重试 | 旧包/旧环境可用，新版本不半更新；没有专用发布条件标阻塞，不降低签名校验 |
| T36 | 检查成功/工程失败任务的Logs与准备取消证据，退出重开 | 任务输入/产物/Verification可追溯；失败取消不转成功。准备取消无需伪造聊天Run/Action |

## 6 真实产品行为与禁止误判

- Pack 安装、环境发现、关联、托管准备是分开的操作。`Detect environment` 不保存；`Check and save environment` 验证后保存；`Prepare managed environment` 成功后会保存所选 profile。
- 本机检测是 owner 声明位置/用户指定路径的有界检查，不是全盘扫描。版本兼容性按固定声明，不是“最新版本都可用”。
- Chip native declaration 当前未 qualified，不因安装了可执行文件就开放整套 native toolchain。
- CUDA 产品入口已撤下；验证新目录及历史已装抑制即可，不部署服务、不索取 CUDA 凭据、不做真实远程工程调用。第三方领域不得被默认目录白名单误删。
- 现有 CLI 的 `doctor` 命令不等于后续提案的逐 capability 安装 Plan/Doctor。自动全域检查、不可变安装计划、REA bundle、持久断点恢复不属于本 PR 已实现能力。
- 历史 GUI 截图和报告只提供定位线索，不是本次验收证据。

## 7 缺陷线索与阻塞处理

以下是待复核线索，不预填结果：

1. K1：复验已修复的旧 Ready 遮盖最近失败问题。保存失败的新选择后，旧关联保留，显示必须以最近失败为准；再次成功才恢复就绪。不预填本轮结果。
2. K2：大文件下载曾有总超时/无断点续传问题；此次分离流程不等于下载器已修复。
3. K3：Harness 当前草稿曾有 CI 失败；按实际 head 获取最新状态及失败日志。
4. 未签名候选、完整冷安装和其他OS不能继承旧原生或fixture测试资格。

每个失败保留首次原始证据，做一次有针对性的复现或隔离诊断；区分产品缺陷、测试脚本缺陷、基础设施问题与未知原因。不要为得到绿色结果修改产品或断言。若必须增补驱动脚本，写到本次证据目录，并标明它调用的生产入口；直接调用底层API不能冒充UI验收。

缺少模型/凭据/服务/目标平台：记录缺少什么、已尝试什么、阻塞哪些ID、继续完成了哪些ID。不能把 blocked 写成 skip 后从分母隐藏。没有新证据不要无限重试或重复询问同一问题。

可用 subagent 并行检查 Host回归、Owner回归和证据审查。GUI由单一agent操作；多个agent不得共用store、config、project或构建输出。顶层QA agent负责最终去重和边界核对。

## 8 最终交付格式

写出 `report.md`、`cases.json`、`manifest.json`，并提供截图/日志/产物的相对路径。所有证据来自本次运行。

`cases.json` 每个实际执行/受阻子项至少包含：

```json
{
  "id": "T12.kicad",
  "status": "blocked",
  "evidenceKind": "real-cold-download",
  "hostCommit": "填写实际提交",
  "ownerCommit": "填写实际提交",
  "platform": "darwin-arm64",
  "startedAt": "ISO8601 UTC",
  "durationSeconds": 0,
  "preconditions": {"cache": "not-established", "application": "not-established"},
  "steps": [],
  "expected": "真实托管下载校验及准备成功",
  "actual": "填写实际观察，不沿用本示例",
  "commands": [],
  "evidence": [],
  "issueId": null,
  "blocker": "填写真实原因；本示例不是测试结果"
}
```

`status` 只用 `passed / failed / blocked / not-applicable / not-run`；不适用必须写理由。`evidenceKind` 区分 `unit-contract / fixture-ui / source-native / packaged-ui / real-cold-download / real-container / controlled-remote / real-remote`，可以记录多种，不混算。

最终报告必须含：

1. **结论**：可验收、限定范围可验收、不可验收或证据不足；说明对应领域/平台/运行方式。
2. **身份与环境**：源码commit、候选app、owner pin、目录、软件/镜像版本、缓存/预装条件。
3. **结果矩阵**：36项主用例和参数化子项分别计数；passed/failed/blocked/not-applicable/not-run全部列出。自动化测试按“文件+完整测试名”去重，重跑另计attempt；UI断言数不叠加为独立用例数。
4. **缺陷**：严重程度、影响、精确复现步骤、预期/实际、证据路径、可能归属层和复现次数。猜测原因必须标注猜测。
5. **关键截图**：四域安装、缺依赖、已有软件关联、显式准备进度/失败/恢复、项目运行结果；fixture图明确标注。
6. **未覆盖与阻塞**：需要什么外部条件才能补齐，不能用“其余正常”概括。
7. **清理与保留**：列出新建目录、下载/镜像、运行进程的处理情况；保留报告所引用的证据，不移除用户原有资源。

验收放行要求：所声称范围内的必测项全部通过、没有未解决阻断缺陷、证据身份一致。任一必测项 blocked/not-run 时不得声称该范围全量通过。工程验证失败与软件安装成功必须分别报告。
