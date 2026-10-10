# QA 测试用例与自动执行手册

> 状态：已落实（与 `main` 分支 CI 对齐）。本文是全部自动化 QA 的**唯一执行入口**：目标读者是 Coding/QA Agent，读完即可在没有人工补充信息的情况下自动运行整个 QA 流程。完成标准与架构不变量见 [Definition of Done 与架构测试](04-definition-of-done-and-architecture-tests.md)；托管 CI 环境细节见 [CI 回归与托管环境](ci-regression.md)。

## 1. Agent 执行协议

按以下顺序执行，不允许跳步或改写判定：

0. **对象与工作区确认**：QA 的验证对象是**当前工作区**（不是 HEAD）。执行前先 `git status --short`，把快照存入本次证据目录，并**保存完整锚定 SHA**：`ANCHOR_SHA="$(git rev-parse HEAD)"`——汇总报告的 `commit` 字段用它，后续一切基线判定也都用它。本仓库常有多会话并行，工作区可能含有不属于本次 QA 的改动（下称**外来文件**）：未提交/未跟踪源文件、被并行会话改写的 `node_modules` 内容（如 frozen-lockfile 安装不含的额外 pack）、机器本地产物。若某层失败且失败来源全部是外来文件，先做**干净基线**：`git worktree add --detach <临时目录> "$ANCHOR_SHA"` → 在该 worktree 内 `pnpm install --frozen-lockfile` → 只重跑失败的层。基线必须使用保存的完整 SHA，**禁止**动态 `HEAD`：并行会话可能在执行期间切换分支，动态 `HEAD` 会验证到与报告锚定提交不一致的代码。基线通过则该层记 `blocked`（原因 `foreign-wip`，notes 列出冲突文件与基线结果），结束后删除临时 worktree；基线仍失败才是代码回归，判 `fail`。若调用方的验证意图是 main 分支健康度而非当前检出，应先 `git fetch origin` 并以 `origin/main` 的完整 SHA 作为锚定。
1. **能力探测**：读取 §2 前置条件矩阵，确定本机可运行的层（T0–T6）。不可运行的层标记 `blocked` 并写明缺失的前置条件，不得伪造结果。
2. **按层执行**：从 T0 开始逐层运行。**任一层 `fail` 即停止后续层**（fail-fast），先排查 §6 的已知 flake；命中已知 flake 可重试一次，重试仍失败则判定 `fail`。**fail-fast 仅由 `fail` 触发**：`blocked`（前置缺失或外来文件冲突）不算失败，不停止后续层——后续层前置满足即照常执行。§6 本地误报处置后的重跑**不占用** flake 重试额度；重跑暴露出的**不同**失败按新失败独立判定。
3. **状态语义**：`pass`/`fail` = 实际执行后的判定；`blocked` = §2 前置缺失或 §1.0 外来文件环境冲突；`skipped` = 因上游层失败被 fail-fast 连带、未启动。
4. **证据收集**：每次运行使用独立子目录 `dist/ci-reports/<UTC时间戳>-<commit短hash>/`（该目录 gitignored），只写入自己的子目录，不改动其他会话留下的文件。`ci-tests.cjs` 固定写到 `dist/ci-reports/<suite>.json`，该固定路径意味着多会话并行运行同一 suite 会互相覆盖，**mtime 校验不足以证明报告归属**（他人在本层执行窗口内覆盖的报告同样"新鲜"）。因此对每个 suite 加**目录锁**：运行前 `mkdir dist/ci-reports/.lock.<suite>`（mkdir 是原子操作；已存在说明另一会话正在跑同一 suite——等待锁消失后重试，等待超时则把该用例记 `blocked` 并注明锁冲突）；suite 完成、把 `<suite>.json` 移入自己子目录后 `rmdir` 解锁。锁只能约束遵守本手册的会话，故移入前仍做兜底校验：报告 mtime ≥ 本 suite 启动时间，且 JSON 内 `platform`/`arch` 与本机一致；任一不符则在本锁保护内重跑该 suite 一次并在 notes 记录。
5. **汇总报告**：全部层执行完后，向调用方输出如下 JSON。`verdict` ∈ `pass|fail|blocked`：所有实际执行的层 pass 且无 blocked → `pass`；无 fail 但存在 blocked → `blocked`（共享工作区无法下结论，建议干净环境重跑）；否则 `fail`。tier 对象必须含 `cases` 数组逐用例记录：

```json
{
  "startedAt": "2026-10-09T12:24:12Z",
  "platform": "darwin",
  "arch": "arm64",
  "node": "v26.10.0",
  "commit": "<git rev-parse HEAD>",
  "tiers": [
    {
      "tier": "T0",
      "status": "fail",
      "cases": [
        { "id": "T0-1", "status": "pass", "evidence": ["dist/ci-reports/<runId>/t0-format.log"] },
        { "id": "T0-2", "status": "fail", "evidence": ["dist/ci-reports/<runId>/t0-architecture.log"] },
        { "id": "T0-3", "status": "pass", "evidence": ["dist/ci-reports/<runId>/t0-release.log"] }
      ]
    },
    { "tier": "T1", "status": "skipped", "reason": "T0 fail-fast" }
  ],
  "verdict": "fail",
  "notes": ["T0-2 失败源于外来文件 apps/cli/src/chat.cjs；HEAD 基线待 §1.0 流程确认"]
}
```

**硬性规则**：超时、崩溃、前置缺失一律是 `fail` 或 `blocked`，永远不允许当作"跳过"处理；不允许为让套件通过而修改测试代码或删除断言。

## 2. 前置条件矩阵

通用（所有层）：macOS/Linux 仓库、Node ≥24、pnpm 11.1.3、`pnpm install --frozen-lockfile` 已执行。

| 层 | 平台 | 额外前置 | 外部网络 |
| --- | --- | --- | --- |
| T0 静态门 | 任意（含 Windows） | 无 | 否 |
| T1 Portable | linux x64/arm64、darwin arm64、win32 x64 | Windows 需把 `C:\Program Files\Git\usr\bin` 加入 PATH（解压 fixture） | 否 |
| T2 桌面 UI selftest | darwin（本地开发机）；CI 在 mac+win 打包产物上跑 | 先 `pnpm --filter @industrial-agent-harness/desktop build`（selftest 加载 **built dist/**，不 build 会测到旧代码） | 否 |
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

### T1 Portable 单元/集成（CI：portable 矩阵，四平台）

| ID | 命令 | 覆盖 | 通过判据 | 证据 |
| --- | --- | --- | --- | --- |
| T1-1 | `pnpm run test:ci -- portable` | 自动发现全部 `packages/*`、`apps/cli`、`apps/desktop` 的 `node --test` 目录（含桌面 13 个主进程单测：updater、window-bounds、session-manager、project-bindings、model-config、chat-history、agent-events、language、gui-permissions、message-content、project-files、project-runtimes、workspace-files），排除 T4 专属文件 | `dist/ci-reports/portable.json` 中 `ok: true`：success 且 failed=cancelled=todo=0，且实际 skip 集合是指允许清单的**子集**——清单内条目当次未跳过属正常（如装有 KLayout 的机器该测试真实执行并通过），清单外出现任何 skip 即 fail（§6） | `portable.json`、`portable.log` |
| T1-2 | `pnpm run smoke:ci-packages` | 独立打包 CLI 消费者验证 | 退出码 0 | `packages.log` |

便携层有 180 秒硬超时：超时即 fail，不会退化成平台跳过。可设 `HARNESS_CI_PLATFORM` / `HARNESS_CI_ARCH` 校验运行平台与预期一致（不匹配直接报错）。

### T2 桌面 UI selftest（本地 dev 机；CI 在打包产物上跑核心子集）

先决：`pnpm --filter @industrial-agent-harness/desktop build`。需要截图证据时设 `INDUSTRIAL_UI_SCREENSHOTS=<dir>`（ui/messages/message-rail 等会写 PNG）。

| ID | 命令（`pnpm --filter @industrial-agent-harness/desktop <script>`） | 覆盖（对应 `electron/*-selftest.cjs`） |
| --- | --- | --- |
| T2-01 | `test:ui` | 工作台主界面：composer 状态机、草稿保留、标签焦点、文本对比度、必要控件不被裁剪 |
| T2-02 | `test:parallel` | 多 Session 并行编排聚合入口 |
| T2-03 | `test:language` | 中英文与跟随系统切换、偏好保存 |
| T2-04 | `test:gui-settings` | 设置弹层交互 |
| T2-05 | `test:messages` | 消息渲染与悬停操作 |
| T2-06 | `test:chats` | 聊天历史（`scripts/test-chats.cjs`） |
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
| T2-19 | `node apps/desktop/scripts/test-install-experience.cjs` | 引导式安装体验（域选择/准备中断退出恢复），需先 build，quit 模式仅 darwin（PR #77 引入）；由 desktop-package.yml 的 mac job 执行 |

CI 参考集：`desktop-package.yml` 跑 `ui language parallel gui-settings` 及 T2-19 install-experience 自测（仅 mac）；`industrial-core.yml` 跑 `chats logs mcp subagents kicad engineering ui language documents images parallel model-sync`。本地全量即把上表全部执行（共 20 个入口，其中 T2-16/T2-17 受 FreeCAD 前置约束）。

### T3 Transport 与 Benchmark（CI：structure.yml 后段）

| ID | 命令 | 覆盖 | 通过判据 |
| --- | --- | --- | --- |
| T3-1 | `pnpm run test:ci -- transport` | 6 个真实传输/策略文件：外部 MCP、domain-mcp-scope（DoD Test G 的 Scope 执行层验证）、pcb-mcp-transport/policy、godot-mcp-policy、chip-runtime-reliability | `transport.json` `ok: true`（允许清单见 §6） |
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

**native-linux（linux x64）准备**只需两步：`node apps/desktop/scripts/setup-kimi.cjs` + 上述 `KIMI_EXECUTABLE` 导出，以及 chip pack 的 `uv sync`（见 industrial-linux.yml）。

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
| T5-2 | mac：`./apps/desktop/node_modules/.bin/electron-builder --projectDir dist/desktop-stage-ci --config electron-builder.config.cjs --mac dmg --arm64 --publish never`；win：同参数 `--win dir` | 产出安装产物 | mac/win |
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

[04 文档](04-definition-of-done-and-architecture-tests.md)定义的门禁在本手册中的落点：

| DoD 项 | 用例 |
| --- | --- |
| Test A/B/C（Core/Adapter/Broker 静态边界） | T0-2 |
| Test D（桌面主进程禁直调工业工具） | T0-2 |
| Test E（Viewer 经 Registry，直分发冻结） | T0-2 + `doc/prototype-register.json` |
| Test F（mutating Tool 必须带 Verification 声明） | T0-2/T0-3 声明检查 |
| Test G（Scope 在执行层验证） | T3-1（`domain-mcp-scope.test.cjs`、`chip-runtime-reliability.test.cjs`） |
| Milestone Gate（Industrial Core Vertical Slice） | T4-2（`industrial-core-vertical-slice.test.cjs`，仅在 native 层运行） |

## 5. 一键执行顺序

按需选择档位；未达成的层按 §1 输出 `blocked`：

- **最小（PR 自检，约 10–15 分钟）**：T0 → T1。
- **标准（本机 darwin arm64 开发机，约 30–45 分钟）**：T0 → T1 → T2（build 后除 CAD 两入口外的全部 selftest）→ T3-2。
- **完整（等价 CI 全网）**：T0 → T1 → T2 → T3 → T4 → T5；T6 由 linux x64 环境执行或引用 CI 结果。

一次性的标准档执行序列（可直接复制）：

```bash
set -euo pipefail
pnpm install --frozen-lockfile
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
EVID="dist/ci-reports/$RUN_ID"; mkdir -p "$EVID"
git status --short | tee "$EVID/git-status.txt"                                            # §1.0 对象确认
pnpm run format:check 2>&1 | tee "$EVID/t0-format.log"                                      # T0-1
pnpm test:architecture 2>&1 | tee "$EVID/t0-architecture.log"                               # T0-2
pnpm run test:release  2>&1 | tee "$EVID/t0-release.log"                                    # T0-3
pnpm run test:ci -- portable 2>&1 | tee "$EVID/portable.log"; mv dist/ci-reports/portable.json "$EVID/"  # T1-1
pnpm run smoke:ci-packages 2>&1 | tee "$EVID/packages.log"                                  # T1-2
pnpm --filter @industrial-agent-harness/desktop build                                        # T2 前置
export INDUSTRIAL_UI_SCREENSHOTS="$PWD/$EVID/ui"; mkdir -p "$INDUSTRIAL_UI_SCREENSHOTS"
for suite in ui parallel language gui-settings messages chats logs mcp external-mcp subagents images kicad godot engineering documents model-sync; do
  pnpm --filter @industrial-agent-harness/desktop "test:$suite" 2>&1 | tee "$EVID/desktop-$suite.log"
done
# T2 CAD 入口（test:cad / test:cad-resize / test:results）不在标准档：需先完成 T4-1 的 FreeCAD 准备
pnpm run test:ci -- benchmark 2>&1 | tee "$EVID/benchmark.log"; mv dist/ci-reports/benchmark.json "$EVID/"  # T3-2
```

## 6. 判定规则、允许跳过与已知 flake

**允许的 skip 清单**（`scripts/ci-tests.cjs` 的判定是**子集语义**：实际 skip 必须全部落在清单内，清单外任何 skip 即 fail；清单内条目当次实际执行而未跳过是合法的，例如装有 KLayout 的机器上该测试会真实运行并通过）：

- portable：`KLayout LayoutView renders a bounded GDS viewport when available`（GDS 视口依赖本机 KLayout）；win32 另允许两条进程清理用例（`timeout and cancellation kill descendants…`、`natural parent exit also cleans up orphaned tools…`）。
- transport：`fixed real PCB-bench source supplies all 89 schemas and complete Skill resources, while host execution remains refused`。

**已知 flake**（命中可重试一次，须在报告 `notes` 中注明）：

- win32 portable 偶发 `spawnSync ETIMEDOUT`（Windows runner IO 抖动），整层重跑一次。
- macOS runner 上 CAD 安装冒烟在 DMG 挂载阶段偶发 300 秒超时；本地重跑通常通过。

**本地环境误报**（按下列处置，不计为代码回归，也不得据此跳过整层）：

- 开发机若运行过 `pnpm --filter @industrial-agent-harness/desktop setup:layout`（GDS 查看引导），`apps/desktop/.venv-klayout` 内的 venv 符号链接会被 T0-2 的 `check-architecture-contract.cjs` 以 `Source symlink is not allowed: apps/desktop/.venv-klayout/...` 拒绝。该 venv 是 gitignored 的机器本地工件，CI 检出中不存在此目录。确认失败路径确以 `.venv-klayout` 开头后，把整个 venv 目录**临时移出仓库**（如 `mv apps/desktop/.venv-klayout /tmp/`），重跑 T0-2，结束后移回原位。不要直接删除：本仓库常有多会话并行，venv 可能正被另一个会话的 GDS 查看使用。
- 并行会话的未提交/未跟踪源文件可能触发 T0-2 的生命周期归属检查（`New adapterCalls outside its owner: <外来文件>#…`，2026-10-09 实测于开发中的 `apps/cli/src/chat.cjs`）。这不是误报也不是 flake：按 §1.0 的外来文件基线规则处置（worktree 基线通过 → `blocked: foreign-wip`；基线也失败 → `fail`）。

**其余任何失败都不属于 flake**，须如实报告并保留 `dist/ci-reports/` 现场。

## 7. 与 CI workflow 的对应

| 层 | Workflow | 触发与门控 |
| --- | --- | --- |
| T0/T3 | `structure.yml`（repository 层） | 每次必跑 |
| T1 | `ci.yml` portable 矩阵 | PR 触及共享代码时跑；docs-only PR 跳过 |
| T2/T5 | `desktop-package.yml` | 非 docs-only PR 跑（mac+win；T2-19 install-experience 自测仅 mac） |
| T4 | `industrial-core.yml` | 非 docs-only PR 跑（darwin arm64） |
| T6 | `industrial-linux.yml` | PR 触及共享代码时跑（linux x64） |
| 汇总 | `ci.yml` 的 `all-checks-passed` | 所有实际运行的层必须 success；main 分支受分支保护约束，不可跨红合并 |

PR 的 area gating 规则：仅 `doc/`、`*.md`、`LICENSE` 变更 → 只跑 repository 层；仅 `apps/desktop/` 变更 → 跳过 portable 与 linux 安装器层。Agent 提交 PR 时可用此预估 CI 范围，但不得据此绕过本地更高档位的自测。

## 8. 维护规则

1. 新增测试文件：包内 `package.json` 的 `test` script 必须保持 `node --test <显式 glob>` 形式——`ci-tests.cjs` 据此自动发现 portable 目录，遇到其他形式会直接报错。
2. 新增桌面 selftest：在 `apps/desktop/package.json` 增加 `test:<name>` script，并在 `electron/main.cjs` 注册 `--<name>-selftest` 派发；同步更新本文 T2 表。
3. 新增 CI 套件或调整平台矩阵：更新 `scripts/ci-tests.cjs` 与对应 workflow 后，同步修订本文 §2/§3/§7。
4. 本手册描述的命令、允许跳过清单与 flake 必须与 `main` 的 CI 一致；发现不一致时以 CI 实际行为为准并立即修订本手册。
