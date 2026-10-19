# 执行协议、判定与证据

所有层和模块都使用本协议。命令目录见 [T0–T6](tiers.md)，产品步骤见[模块矩阵](modules.md)。

按以下顺序执行，不允许跳步或改写判定：

0. **对象与工作区确认**：QA 的验证对象是**当前工作区**（不是 HEAD）。执行前先 `git status --short`，把快照存入本次证据目录，并**保存完整锚定 SHA**：`ANCHOR_SHA="$(git rev-parse HEAD)"`——汇总报告的 `commit` 字段用它，后续一切基线判定也都用它。本仓库常有多会话并行，工作区可能含有不属于本次 QA 的改动（下称**外来文件**）：未提交/未跟踪源文件、被并行会话改写的 `node_modules` 内容（如 frozen-lockfile 安装不含的额外 pack）、机器本地产物。若某层失败且失败来源全部是外来文件，先做**干净基线**：`git worktree add --detach <临时目录> "$ANCHOR_SHA"` → 在该 worktree 内 `pnpm install --frozen-lockfile` → 只重跑失败的层。基线必须使用保存的完整 SHA，**禁止**动态 `HEAD`：并行会话可能在执行期间切换分支，动态 `HEAD` 会验证到与报告锚定提交不一致的代码。基线通过则该层记 `blocked`（原因 `foreign-wip`，notes 列出冲突文件与基线结果），结束后删除临时 worktree；基线仍失败才是代码回归，判 `fail`。若调用方的验证意图是 main 分支健康度而非当前检出，应先 `git fetch origin` 并以 `origin/main` 的完整 SHA 作为锚定。
1. **能力探测**：读取 [分层前置条件矩阵](tiers.md)，确定本机可运行的层（T0–T6）。不可运行的层标记 `blocked` 并写明缺失的前置条件，不得伪造结果。
2. **按层执行**：从 T0 开始逐层运行。**任一层 `fail` 即停止后续层**（fail-fast），先排查 下文判定规则 的已知 flake；命中已知 flake 可重试一次，重试仍失败则判定 `fail`。**fail-fast 仅由 `fail` 触发**：`blocked`（前置缺失或外来文件冲突）不算失败，不停止后续层——后续层前置满足即照常执行。下文判定规则 本地误报处置后的重跑**不占用** flake 重试额度；重跑暴露出的**不同**失败按新失败独立判定。
3. **状态语义**：`pass`/`fail` = 实际执行后的判定；`blocked` = 前置条件缺失或 对象与工作区确认流程 外来文件环境冲突；`skipped` = 因上游层失败被 fail-fast 连带、未启动。
4. **证据收集**：每次运行使用独立子目录 `dist/ci-reports/<UTC时间戳>-<commit短hash>/`（该目录 gitignored），只写入自己的子目录，不改动其他会话留下的文件。`ci-tests.cjs` 固定写到 `dist/ci-reports/<suite>.json`，该固定路径意味着多会话并行运行同一 suite 会互相覆盖，**mtime 校验不足以证明报告归属**（他人在本层执行窗口内覆盖的报告同样"新鲜"）。因此对每个 suite 加**目录锁**：运行前 `mkdir dist/ci-reports/.lock.<suite>`（mkdir 是原子操作；已存在说明另一会话正在跑同一 suite——等待锁消失后重试，等待超时则把该用例记 `blocked` 并注明锁冲突）；suite 完成、把 `<suite>.json` 移入自己子目录后 `rmdir` 解锁。锁只能约束遵守本手册的会话，故移入前仍做兜底校验：报告 mtime ≥ 本 suite 启动时间，且 JSON 内 `suite` 与所持锁一致、`platform`/`arch` 与本机一致；任一不符则在本锁保护内重跑该 suite 一次并在 notes 记录。
5. **汇总报告**：全部层执行完后，向调用方输出如下 JSON。`verdict` ∈ `pass|fail|blocked`：所有实际执行的层 pass 且无 blocked → `pass`；无 fail 但存在 blocked → `blocked`（共享工作区无法下结论，建议干净环境重跑）；否则 `fail`。tier 对象必须含 `cases` 数组逐用例记录：

```json
{
  "startedAt": "2026-10-09T12:24:12Z",
  "platform": "darwin",
  "arch": "arm64",
  "node": "v26.10.0",
  "commit": "<执行前保存的完整 ANCHOR_SHA>",
  "tiers": [
    {
      "tier": "T0",
      "status": "fail",
      "cases": [
        { "id": "T0-1", "status": "pass", "evidence": ["dist/ci-reports/<runId>/t0-format.log"] },
        { "id": "T0-2", "status": "fail", "evidence": ["dist/ci-reports/<runId>/t0-architecture.log"] },
        { "id": "T0-3", "status": "skipped", "reason": "T0-2 fail-fast", "evidence": [] },
        { "id": "T0-4", "status": "skipped", "reason": "T0-2 fail-fast", "evidence": [] }
      ]
    },
    { "tier": "T1", "status": "skipped", "reason": "T0 fail-fast", "cases": [] }
  ],
  "verdict": "fail",
  "notes": ["示例：T0-2 已在锚定 SHA 的干净基线复现失败；T2–T6 同样记录 skipped 与空 cases"]
}
```

**硬性规则**：超时、崩溃、前置缺失一律是 `fail` 或 `blocked`，永远不允许当作"跳过"处理；不允许为让套件通过而修改测试代码或删除断言。

6. **清理**：运行结束（无论 verdict）执行 `node scripts/qa-cleanup.cjs` 预览，逐项检查预览审计清单、确认无其他会话使用后，才可再执行 `node scripts/qa-cleanup.cjs --apply`；不得将预览与删除串成无条件命令。脚本只回收四类目标：闲置 ≥7 天的构建/暂存产物（`dist/` 除 `ci-reports` 外与 `apps/desktop/dist`）、留存 ≥14 天的证据目录（与 CI artifact 保留期一致）、超过 6 小时的孤儿 suite 锁、闲置 ≥7 天且无未提交改动的本仓库 `/tmp` worktree（崩溃遗留的基线/测试 worktree）。安全栏：任何 git-tracked、未 ignore、保留期内、或被运行中进程命令行引用的目标一律跳过并记录原因；默认预览，`--apply` 才删除；单实例锁防并发；每次运行留 `dist/ci-reports/qa-cleanup-<时间戳>.json` 审计日志。保留期可用 `--retention-builds/--retention-evidence/--retention-worktree/--lock-ttl-hours` 覆盖。

## 判定规则、允许跳过与已知 flake

**允许的 skip 清单**（`scripts/ci-tests.cjs` 的判定是**子集语义**：实际 skip 必须全部落在清单内，清单外任何 skip 即 fail；清单内条目当次实际执行而未跳过是合法的，例如装有 KLayout 的机器上该测试会真实运行并通过）：

- portable：`KLayout LayoutView renders a bounded GDS viewport when available`（GDS 视口依赖本机 KLayout）；win32 另允许四条：`timeout and cancellation kill descendants and close the result promise`、`natural parent exit also cleans up orphaned tools before close`、`a real login shell reports its PATH between the markers`、`a hanging login shell is abandoned after the timeout`。
- transport：`fixed real PCB-bench source supplies all 89 schemas and complete Skill resources, while host execution remains refused`。

**已知 flake**（命中可重试一次，须在报告 `notes` 中注明）：

- `test:messages` 偶发失败（2026-10-10 在 main 实测 4 跑 1 挂、复跑 3/3 过；覆盖悬停/剪贴板/Markdown/时间戳/主题断言）。复跑通常通过；CI 若再现同款失败值得加稳定化。

- win32 portable 偶发 `spawnSync ETIMEDOUT`（Windows runner IO 抖动），整层重跑一次。
- macOS runner 上 CAD 安装冒烟在 DMG 挂载阶段偶发 300 秒超时；本地重跑通常通过。

**本地环境误报**（按下列处置，不计为代码回归，也不得据此跳过整层）：

- T0-2 报 `Protected architecture machinery changed: <file>. Use a separately approved architecture revision.` 是**治理机制按设计报警**，不是测试错误：`architecture/policy.json` 的 `governanceHashes` 钉死了 9 个机制文件（architecture-contract.yml、check-architecture-contract.cjs、fetch-architecture-candidate.cjs 等）。普通功能 PR 不应改动这些文件；确需修改时走单独的架构修订（合并后必须同 PR 重算 governanceHashes，否则 main 上后续所有 PR 都会红）。

- 开发机若运行过 `pnpm --filter @industrial-agent-harness/desktop setup:layout`（GDS 查看引导），`apps/desktop/.venv-klayout` 内的 venv 符号链接会被 T0-2 的 `check-architecture-contract.cjs` 以 `Source symlink is not allowed: apps/desktop/.venv-klayout/...` 拒绝。该 venv 是 gitignored 的机器本地工件，CI 检出中不存在此目录。确认失败路径确以 `.venv-klayout` 开头后，把整个 venv 目录**临时移出仓库**（如 `mv apps/desktop/.venv-klayout /tmp/`），重跑 T0-2，结束后移回原位。不要直接删除：本仓库常有多会话并行，venv 可能正被另一个会话的 GDS 查看使用。
- 并行会话的未提交/未跟踪源文件可能触发 T0-2 的生命周期归属检查（`New adapterCalls outside its owner: <外来文件>#…`，2026-10-09 已遇到过开发中 CLI 文件触发）。这不是误报也不是 flake：按对象与工作区确认流程处理（worktree 基线通过 → `blocked: foreign-wip`；基线也失败 → `fail`）。

**其余任何失败都不属于 flake**，须如实报告并保留 `dist/ci-reports/` 现场。

## 维护规则

1. 新增测试文件：包内 `package.json` 的 `test` script 必须保持 `node --test <显式 glob>` 形式——`ci-tests.cjs` 据此自动发现 portable 目录，遇到其他形式会直接报错。
2. 新增桌面 selftest：在 `apps/desktop/package.json` 增加 `test:<name>` script，并在 `electron/main.cjs` 注册 `--<name>-selftest` 派发；同步更新[T2 表](tiers.md)。
3. 新增 CI 套件或调整平台矩阵：更新 `scripts/ci-tests.cjs` 与对应 workflow 后，同步修订本文 [分层命令及 CI 对照](tiers.md)。
4. 本手册描述的命令、允许跳过清单与 flake 必须与 `main` 的 CI 一致；发现不一致时以 CI 实际行为为准并立即修订本手册。
5. 清理目标与保留期由 清理流程 与 `scripts/qa-cleanup.cjs` 共同定义：新增目标类别或调整保留期时两者必须同步修改，且 `tests/ci/qa-cleanup.test.cjs` 须覆盖新的判定分支。

## 执行准备与命令纪律

1. 保存完整 `ANCHOR_SHA`、`git status --short`、`git diff --stat` 和 Node/pnpm/OS 版本，再安装固定依赖。commit 只是基线身份，dirty 快照必须同时报告；不得宣称测试的是纯提交。
2. **验证依赖身份**：不能只检查 node_modules 存在，也不能复制其他工作区的 node_modules 充当 frozen install。记录本次 `pnpm install --frozen-lockfile` 的退出码，核对根/CLI/Desktop 声明、lockfile、实际解析到的 `@zhiman-bj/industrial-domain-packs` archive commit/版本及实际 manifest/provenance。可用 `node scripts/pack-source.cjs chip-pack` 等打印各 Pack 实际路径，检查其来自固定依赖而非额外本地 Pack。当前基线 pin 为 `f91a8ab3c071e4500fd4097bb3123a7fbb0ca635`；实际依赖不同就记录 environment drift，在独立干净工作区安装校准，不能将该测试冒充锁定依赖验收。
3. 用 `mktemp -d "dist/ci-reports/<UTC>-<短SHA>-XXXXXX"` 创建唯一目录并保存绝对路径，避免同秒同提交会话撞名。所有模块日志/截图/探测都放自己的子目录，不复用上次成功文件。
4. 六个 test:ci suite 必须持有对应目录锁。记录开始/结束时间、退出码，失败也保留有效 JSON；无本次报告就记缺失，不能搬旧文件。归档后才释放自己创建的锁，设有界等待（例如五分钟）；不要删除未知持有者的锁。异常中断后的锁交给预览审查过的 cleanup 处理。
5. 命令表是独立用例，不是可无条件粘贴的全量脚本。管道使用 Bash `set -o pipefail`，保留实际命令退出码。同层失败后未启动用例也标 skipped；blocked 不触发 fail-fast。
6. 手工验收逐 ID 记录步骤、实际/预期、平台、产品包/Pack 身份、输入及证据。未执行不能标 pass；因环境阻塞须写缺失项。敏感账号/模型及工程资料不附公开报告，只记录脱敏结论与错误码。
7. 环境错误必须先留原始证据并定位。例如 T0-2 的 `ENOBUFS` 不是已登记 flake，不能仅凭重跑成功就自动按 flake 改判；应说明受限环境、实际命令与失败位置，在干净、前置满足环境重验，保留原结果。
8. 只清理自己创建且无未提交数据的临时 worktree；cleanup 无候选时不需要 apply。本次新证据不能进入删除清单。

[返回入口](../qa-runbook.md) · [模块矩阵](modules.md)
