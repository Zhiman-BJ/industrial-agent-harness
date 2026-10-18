# T0–T6 分层命令与 CI 对照

所有命令在仓库根执行，先遵守[执行协议](protocol.md)。test:ci 必须持对应 suite 锁；原始退出码与本次 JSON 判据都满足才可判通过。产品路径另见[模块矩阵](modules.md)。

## 2. 前置条件矩阵

通用（所有层）：原生检出仓库、Node ≥24、pnpm 11.1.3、`pnpm install --frozen-lockfile` 已执行。

| 层 | 平台 | 额外前置 | 外部网络 |
| --- | --- | --- | --- |
| T0 静态门 | 任意（含 Windows） | 无 | 否 |
| T1 Portable | linux x64/arm64、darwin arm64、win32 x64 | Windows 需把 `C:\Program Files\Git\usr\bin` 加入 PATH（解压 fixture） | 否 |
| T2 桌面 UI selftest | darwin（本地开发机）；CI mac+win 另验打包产物，常规 selftest 走源码 Electron 入口 | 先 `pnpm --filter @industrial-agent-harness/desktop build`（selftest 加载 **built dist/**，不 build 会测到旧代码） | 否 |
| T3 Transport / Benchmark | 任意 | Transport 需解析 Domain Pack 源 + `uv`（pip 安装 `uv==0.11.6`）+ Python 3.13；Benchmark 需 `iverilog`、`vvp` | 是（首次解析 Pack 源） |
| T4 Native 工业内核 | darwin arm64（native）或 linux x64（native-linux） | `KIMI_EXECUTABLE`（`node apps/desktop/scripts/setup-kimi.cjs` 生成）；native 另需 `INDUSTRIAL_HARNESS_FREECAD_CMD`；chip pack `eda-harness/.venv`（`uv sync --frozen --no-dev --python 3.13`）；`verilator`、`rg` | 是（setup 脚本下载受保护运行时） |
| T5 打包与安装冒烟 | mac（DMG + CAD 安装）/ win（dir 产物） | T2 的 build 已完成；`electron-builder` 随 devDependencies 提供；CAD 安装冒烟仅 **darwin arm64** | 是（下载官方 FreeCAD DMG，可用 `HARNESS_CAD_INSTALL_ARCHIVE` 预置缓存） |
| T6 Linux chip 安装器 | linux x64（CI 托管） | Docker；`scripts/package-linux-chip-installer.cjs` 构建产物 | 是 |

说明：

- **真实模型密钥**：T0–T6 全部不需要用户模型密钥。T4 使用随仓库 `setup-kimi.cjs` 安装的受保护 Kimi 可执行文件；需要真实第三方模型的 bench（`apps/cli` 的非 `--scope-only` 运行）不属于本手册范围。
- **selftest 隔离**：任何 `*-selftest` 标志都会让桌面主进程把聊天目录、资源目录和 `INDUSTRIAL_HARNESS_CONFIG_DIR` 重定向到隔离位置（`apps/desktop/electron/main.cjs`），在开发机上运行不会污染真实用户数据。
- **自定义探针警告**：不要在自写 Electron 探针中使用任何以 `-selftest` 结尾的自定义 flag——主进程会对这类 flag 注入语言脚本并在失败时 `app.exit(1)`。

## 3. 分层用例目录

所有命令在仓库根目录执行。`pnpm run test:ci -- <suite>` 由 `scripts/ci-tests.cjs` 编排：套件 ∈ `portable | native | native-installed | native-linux | benchmark | transport`，报告写入 `dist/ci-reports/<suite>.json`。

### T0 仓库结构与静态门（CI：structure.yml）

| ID | 命令 | 覆盖 | 通过判据 |
| --- | --- | --- | --- |
| T0-1 | `pnpm run format:check` | 全仓 prettier | 退出码 0 |
| T0-2 | `pnpm test:architecture` | `check-architecture-contract.cjs` + `tests/architecture/*.test.cjs`：静态依赖边界（DoD Test A/B/C/D）、Prototype 冻结、桌面主进程禁止直调工业可执行文件 | 退出码 0 |
| T0-3 | `pnpm run test:release` | `check-pack-release.cjs`：Pack 发行内容与兼容性 | 退出码 0 |
| T0-4 | `pnpm run lint` | ESLint 全仓静态分析（structure.yml 的 "Static analysis" 门） | 退出码 0 |

### T1 Portable 单元/集成（CI：portable 矩阵，四平台）

| ID | 命令 | 覆盖 | 通过判据 | 证据 |
| --- | --- | --- | --- | --- |
| T1-1 | `pnpm run test:ci -- portable` | 自动发现全部 `packages/*`、`apps/cli`、`apps/desktop` 的 `node --test` 目录（桌面 `electron/*.test.cjs`、账号、资源、安装、成果和 CI 管理回归；按各包脚本动态发现），排除 T4 专属文件 | `dist/ci-reports/portable.json` 中 `ok: true`：success 且 failed=cancelled=todo=0，且实际 skip 集合是指允许清单的**子集**——清单内条目当次未跳过属正常（如装有 KLayout 的机器该测试真实执行并通过），清单外出现任何 skip 即 fail（[协议判定规则](protocol.md)） | `portable.json`、`portable.log` |
| T1-2 | `pnpm run smoke:ci-packages` | 独立打包 CLI 消费者验证 | 退出码 0 | `packages.log` |

便携层有 180 秒硬超时：超时即 fail，不会退化成平台跳过。可设 `HARNESS_CI_PLATFORM` / `HARNESS_CI_ARCH` 校验运行平台与预期一致（不匹配直接报错）。

### T2 桌面 UI selftest（本地 dev 机；CI 另验打包产物，UI 核心子集从源码入口执行）

先决：`pnpm --filter @industrial-agent-harness/desktop build`。需要截图证据时设 `INDUSTRIAL_UI_SCREENSHOTS=<dir>`（ui/messages/message-rail 等会写 PNG）。

| ID | 命令（`pnpm --filter @industrial-agent-harness/desktop <script>`） | 覆盖（对应 `electron/*-selftest.cjs`） |
| --- | --- | --- |
| T2-01 | `test:ui` | 工作台主界面：composer 状态机、草稿保留、标签焦点、文本对比度、必要控件不被裁剪 |
| T2-02 | `test:parallel` | 多 Session 并行编排；真实 Renderer 强制崩溃后由测试显式 reload，验证历史/终态去重及新任务恢复；不证明产品自动自愈 |
| T2-03 | `test:language` | 中英文与跟随系统切换、偏好保存 |
| T2-04 | `test:gui-settings` | 设置弹层交互 |
| T2-05 | `test:messages` | 消息渲染与悬停操作 |
| T2-06 | `test:chats` | 聊天历史（`apps/desktop/scripts/test-chats.cjs`） |
| T2-07 | `test:logs` | Agent 日志与资源面板（内含 resource selftest：能力中心资源行） |
| T2-08 | `test:mcp` | 域 MCP 会话接入 UI |
| T2-09 | `test:external-mcp` | 外部 MCP 注册与审批 UI |
| T2-10 | `test:subagents` | Subagent 卡片与 Agent 工具行 |
| T2-11 | `test:images` | 图片输入管线 |
| T2-12 | `test:kicad` | KiCad 板图/原理图 Viewer |
| T2-13 | `test:godot` | Godot Web Export Viewer |
| T2-14 | `test:engineering` | 工程文件只读预览 |
| T2-15 | `test:documents` | 通用文件 Viewer（CSV/JSON/Markdown 等） |
| T2-16 | `test:cad` / `test:cad-resize` | CAD 领域交互 / 视口 resize。真实调用 `cad.freecad.build`/`cad.freecad.export` 工具，**必须先完成 T4-1 native 准备中的 FreeCAD 步骤并导出 `INDUSTRIAL_HARNESS_FREECAD_CMD`**，否则在干净环境必然失败 |
| T2-17 | `test:results` | 任务成果卡：自动成果生成、版本关联、预览与历史重载（PR #72 引入）。**驱动真实 CAD 任务并断言结果卡与渲染三角数，同 T2-16 需 FreeCAD 前置**；CI 中该路径由 T4 native 套件的 `task-results-freecad/kimi.test.cjs` 覆盖，selftest 本身不进任何 workflow 循环 |
| T2-18 | `test:model-sync` | 模型/项目配置广播同步：非 UI 的 `model:save`、`project:create` 后渲染端状态免刷新（PR #75 引入） |
| T2-20 | `test:browser` | 工作区内嵌浏览器标签（PR #132）：导航、安全边界与工作区集成 |
| T2-21 | `test:account` | Obol OIDC 登录（PR #151）：受控签名 OIDC 服务下的真实 Electron 登录、令牌刷新、取消、粘贴凭据与登出；不证明生产服务或 OS 浏览器 opener；协议层（签名 OIDC、loopback 真实 socket 验签）由 `account-login.yml` 的单测步覆盖 |
| T2-19 | `node apps/desktop/scripts/test-install-experience.cjs` | 引导式安装体验（域选择/准备中断退出恢复），需先 build，quit 模式仅 darwin（PR #77 引入）；由 desktop-package.yml 的 mac job 执行 |

CI 参考集：`desktop-package.yml` 跑 `ui language parallel gui-settings` 及 T2-19 install-experience 自测（仅 mac）；`industrial-core.yml` 跑 `chats logs mcp subagents kicad engineering ui language documents images parallel model-sync`。另有 `--replay-selftest`（PR #141：轨迹回放走产品事件咽喉）为裸 flag 驱动，暂无 `test:` 入口、不在任何 CI 循环，手动执行 `pnpm --filter @industrial-agent-harness/desktop exec electron . --replay-selftest`。本地全量以表中实际入口为准；T2-16 两个命令分别记录。裸 flag 与 package script 的存在均不证明进入 CI。模态键盘边界由 `test:ui`、`test:account` 与 portable 的 `modal-focus.test.cjs` 覆盖。

### T3 Transport 与 Benchmark（CI：structure.yml 后段）

| ID | 命令 | 覆盖 | 通过判据 |
| --- | --- | --- | --- |
| T3-1 | `pnpm run test:ci -- transport` | 6 个真实传输/策略文件：外部 MCP、domain-mcp-scope（DoD Test G 的 Scope 执行层验证）、pcb-mcp-transport/policy、godot-mcp-policy、chip-runtime-reliability | `transport.json` `ok: true`（允许清单见 [协议判定规则](protocol.md)） |
| T3-2 | `pnpm run test:ci -- benchmark` | `tests/benchmark/paired.test.cjs` 配对工程冒烟（需 iverilog/vvp） | `benchmark.json` `ok: true` |

### T4 Native 工业内核（CI：industrial-core.yml；native=darwin arm64，native-linux=linux x64）

前置检查由 `ci-tests.cjs` 自带：平台/KIMI_EXECUTABLE/FreeCAD/chip venv/verilator/rg 缺一即报错退出。

**native（darwin arm64）完整准备**（与 industrial-core.yml 等价，可直接复制；在仓库根执行）：

```bash
python -m pip install uv==0.11.6 && brew install verilator ripgrep
node apps/desktop/scripts/setup-kimi.cjs
export KIMI_EXECUTABLE="$(node -p "require('./packages/agent-kimi/src/code-session.cjs').bundledExecutable()")"
(cd "$(node scripts/pack-source.cjs chip-pack)/eda-harness" && uv sync --frozen --no-dev --python 3.13)
export INDUSTRIAL_HARNESS_FREECAD_CMD="$(node scripts/setup-freecad.cjs)"   # stdout 即官方 FreeCAD 可执行路径
for pack in pcb godot; do node "$(node scripts/pack-source.cjs "$pack-pack")/runtime/setup-native.cjs" "$PWD/dist/$pack-runtime"; done
node scripts/package-headless.cjs dist/freecad-cli --domain cad
node scripts/package-headless.cjs dist/professional-cli
HARNESS_BOOTSTRAP_DOMAINS='' node scripts/stage-desktop.cjs dist/professional-desktop
export HARNESS_FREECAD_TEST_CLI="$PWD/dist/freecad-cli/industrial-harness.cjs"
export HARNESS_PROFESSIONAL_TEST_CLI="$PWD/dist/professional-cli/industrial-harness.cjs"
export HARNESS_PROFESSIONAL_DESKTOP_ENTRY="$PWD/dist/professional-desktop/electron/main.cjs"
export HARNESS_PROFESSIONAL_EVIDENCE="$PWD/dist/ci-reports/professional-evidence"; mkdir -p "$HARNESS_PROFESSIONAL_EVIDENCE"
```

**native-linux（linux x64）准备**：安装 `uv==0.11.6`、Python 3.13、`verilator`、`rg` 及 Linux sandbox 的 bubblewrap，检查 user namespace 可用；执行 `node apps/desktop/scripts/setup-kimi.cjs`，导出上述 `KIMI_EXECUTABLE`，为 chip pack 执行 `uv sync`。完整安装器/Docker 工具与固定 Verilator 编译方式见 `industrial-linux.yml`，不是两条 setup 命令即可完成环境资格。

| ID | 命令 | 覆盖 |
| --- | --- | --- |
| T4-1 | 执行上方准备命令块 | 受保护 Agent、官方 FreeCAD、pcb/godot 原生运行时与独立 CLI/Desktop 打包（professional/freecad 测试入口的绑定来源） |
| T4-2 | `pnpm run test:ci -- native`（或 `native-linux`） | `industrial-core-vertical-slice.test.cjs`（里程碑 Gate：StateProvider→Broker→Scoped Tool→Runtime→Verilator→Artifact→Verifier→Checkpoint 真实闭环）、installed-pack、pcb-godot runtime、freecad-runtime、后台任务、沙箱、会话混沌/资源、MCP 实测；文件清单由 `scripts/ci-tests.cjs` 维护 |
| T4-2a | `pnpm run test:ci -- native-installed`（darwin arm64） | 独立必跑安装组，串行执行 `freecad-installed.test.cjs` 和 `pcb-godot-installed.test.cjs` 的三项全新托管安装与真实工程验收；原断言、执行截止与零跳过要求保留。准备使用固定官方归档与独立 CLI/Desktop payload，见 `industrial-core.yml` 的安装 job |
| T4-3 | `node --test tests/integration/headless-package-kimi.test.cjs` | 打包 headless Agent 的生产进程边界 |
| T4-4 | 打包 CLI + 工作区验证：对 chip/pcb/godot 依次 `node scripts/package-headless.cjs dist/workspace-<domain> --domain <domain>` 后 `node scripts/smoke-workspace-cli.cjs <cli> <domain> <evidence.json>` | 三个领域的独立 CLI 真实任务与 MCP |

### T5 桌面打包与安装冒烟（CI：desktop-package.yml，mac+win）

| ID | 命令 | 覆盖 | 平台 |
| --- | --- | --- | --- |
| T5-1 | `pnpm --filter @industrial-agent-harness/desktop build` && `node scripts/stage-desktop.cjs dist/desktop-stage-ci` | 构建并暂存可安装应用 | mac/win |
| T5-2 | mac：`./apps/desktop/node_modules/.bin/electron-builder --projectDir dist/desktop-stage-ci --config "$PWD/electron-builder.config.cjs" --mac dmg --arm64 --publish never`；win：用 `.cmd` 和仓库根绝对 config 路径，改为 `--win dir --publish never` | 产出安装产物 | mac/win |
| T5-3 | `node scripts/smoke-packaged-desktop.cjs` | 打包应用首次启动（域选择首屏）；设 `HARNESS_PACKAGED_SMOKE_SCREENSHOT=<png>` 留证 | mac/win |
| T5-4 | `node scripts/smoke-packaged-desktop.cjs --domains` | 平台限定域安装 | mac/win |
| T5-5 | `node scripts/smoke-packaged-cad.cjs <全新证据目录> --dmg` | **真实安装流**：首装 UI 勾选 CAD → 下载官方 FreeCAD DMG（sha256 校验、挂载与原生验证不 mock）→ runtime ready → 重启应用验证依赖/项目绑定/verified actions 持久化。证据目录必须不存在（脚本强制全新）。可用 `HARNESS_CAD_INSTALL_ARCHIVE` 预置官方 DMG 缓存、`HARNESS_CAD_INSTALL_APP` 指定被测可执行文件 | 仅 darwin arm64 |

### T6 Linux chip 安装器验收（CI：industrial-linux.yml，linux x64 托管）

| ID | 命令 | 覆盖 |
| --- | --- | --- |
| T6-1 | `node scripts/package-linux-chip-installer.cjs dist/chip-cli.tar.gz dist/linux-chip-release/<installer>.run <tag>` | 构建不可变 `.run` 安装器并输出 build-identity |
| T6-2 | 安装到真实前缀后 `node scripts/smoke-linux-chip-install.cjs <prefix> <launcher> <verification.json>` | install-receipt 校验（sourceDirty=false、受保护 Kimi 启动 PASS）+ 安装出的消费者跑真实 Verilator/Docker 任务 |
| T6-3 | 旧版 preview 安装器 → 新版升级路径 | 同 T6-2 双轮验证 |

本机不是 linux x64 时整层标记 `blocked`，以 CI workflow `industrial-linux.yml` 的结果为准。

## 4. DoD Gate 映射

[04 文档](../04-definition-of-done-and-architecture-tests.md)定义的门禁在本手册中的落点：

| DoD 项 | 用例 |
| --- | --- |
| Test A/B/C（Core/Adapter/Broker 静态边界） | T0-2 |
| Test D（桌面主进程禁直调工业工具） | T0-2 |
| Test E（Viewer 经 Registry，直分发冻结） | T0-2 + `doc/prototype-register.json` |
| Test F（mutating Tool 必须带 Verification 声明） | T0-2/T0-3 声明检查 |
| Test G（Scope 在执行层验证） | T3-1（`domain-mcp-scope.test.cjs`、`chip-runtime-reliability.test.cjs`） |
| Milestone Gate（Industrial Core Vertical Slice） | T4-2（`industrial-core-vertical-slice.test.cjs`，在 native/native-linux 层运行） |

## 7. 与 CI workflow 的对应

| 层 | Workflow | 触发与门控 |
| --- | --- | --- |
| T0/T3 | `structure.yml`（repository 层：format/architecture/release/**lint**/治理文档存在性检查 + Desktop renderer 构建 + benchmark/transport + owner Chip pytest） | 每次必跑 |
| T1 | `ci.yml` portable 矩阵（含 `harness-auth` 包单测自动发现） | 所有非 docs-only PR 的 core 检查；完整运行也执行 |
| 鉴权 | `account-login.yml`（macos-15 + windows-2025） | paths 触发（`packages/harness-auth/**`、`apps/**`、lockfile）：协议单测（loopback 验签，无外网/无 secrets）+ 桌面 `test:account`；证据留档 14 天 |
| T2/T5 | `desktop-package.yml` | 非 docs-only PR 跑（mac+win；T2-19 install-experience 自测仅 mac） |
| T4 | `industrial-core.yml` | full 检查才跑（main push 或显式 full；macos-15/macOS-26） |
| T6 | `industrial-linux.yml` | 所有非 docs-only PR 的 core 检查（linux x64） |
| 汇总 | `ci.yml` 的 `all-checks-passed` | 所有实际运行的层必须 success；main 分支受分支保护约束，不可跨红合并 |

PR 的 area gating 规则：仅 `doc/`、`*.md`、`LICENSE` 变更 → 只跑 repository 层；仅 `apps/desktop/` 变更仍是 core，运行 portable、desktop 和 industrial-linux。Agent 提交 PR 时可用此预估 CI 范围，但不得据此绕过本地更高档位的自测。


## 档位与运行范围

| 档位 | 顺序与记录要求 |
| --- | --- |
| PR 最小 | T0 全四项 → T1；有产品变化再做模块定向检查，不能省略 lint |
| macOS 标准 | T0 → T1 → build → T2 前置满足的入口 → T3；缺 uv/RTL 工具/FreeCAD 的具体用例标 blocked |
| 完整 | T0 → T1 → T2 → T3 → T4（含独立 native-installed）→ T5 → Linux x64 的 T6；跨机证据分别保留 SHA/平台/状态 |

不再提供旧版一键脚本：它遗漏 T0 lint、完整 SHA 锚定、suite 锁，并无条件 cleanup apply，与[协议](protocol.md)冲突。按用例逐项执行，保留 blocked、fail-fast 和报告归属。

### 源码／workflow 核对补充

- native 当前要求恰好 68 项、native-installed 恰好 3 项且零 skip。native-installed 并发为 1，native/native-linux 为 2；单独运行文件不能替代完整 suite。
- T3 transport 先解析固定 owner Pack；chip 的 eda-harness 与 pcb Pack 各执行 `uv sync --frozen --no-dev --python 3.13 --directory <路径>`；structure 另跑 chip `uv run --frozen --directory <路径> python -m pytest -q`。不修改冻结领域源码。
- native-installed 单独安装组不要求 chip venv/Verilator/预装 FreeCAD，但要求固定 Kimi、rg、独立 professional CLI/Desktop payload。先执行 `node scripts/prepare-ci-runtime-archives.cjs --download`，再用上表导出的 professional 路径和证据目录运行。官方归档缓存与安装后软件分别验身份，冷下载和复用分别标注。
- industrial-core 还单独执行 cad-resize 与 external-mcp；普通 selftest 以源码 Electron 加载 built renderer，不能写成全部在打包应用上运行。安装包真实消费者另由 T5 和 installed 路径验证。
- account-login 是独立 paths 检查，**不在 ci.yml 的 all-checks-passed 依赖中**；聚合成功不表示账号工作流已触发。
- `scripts/ci-areas.cjs plan()` 的 core 对所有非 docs-only PR 为 true，含纯 Desktop 变更：portable、desktop、industrial-linux 均执行。full 对 main push 和显式 full 运行成立，才执行 industrial-core，并启用 desktop 完整安装、Linux 升级/Docker 分支；普通 PR 通常 full=false。
- T6 完整 installer/upgrade/Docker 只在 full 执行。industrial-linux 的 core 模式仍跑 native-linux、linux-chip-bootstrap 与 headless 生产进程边界，不可把 workflow job 成功当成 T6 安装器全流程已执行。
- macOS/Windows 的具体包、原生工程和账号安全存储资格分别记录；未执行的平台不得由源码或 CI 矩阵名称推断支持。

### 性能与崩溃恢复补充

不新增虚构的 T7 或性能门禁。按 [PF 模块](performance-recovery.md)在 T1 对流事件/历史/有界读取/关停、T2 对布局/Renderer reload 及真实 Renderer 强制崩溃后的测试显式 reload 恢复、T4 对真实 Kimi 进程死亡/取消/恢复取证；`pnpm benchmark:maintenance` 和 `pnpm stress:sessions` 是额外测量入口，不在现有 T0–T6 成功语义里隐含执行。现有 Renderer crash 场景不证明自动自愈；main 真崩溃、目标平台/不同任务阶段恢复、首个可用画面、UI 大负载时延及无孤儿进程仍按 PF 手工矩阵补测。没有约定阈值的性能值只报告，不判性能合格；所有问题进入同一个汇总 issue。

[返回入口](../qa-runbook.md) · [模块矩阵](modules.md)
