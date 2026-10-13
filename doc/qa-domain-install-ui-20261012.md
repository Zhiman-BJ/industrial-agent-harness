# 领域安装界面与 CUDA 撤下验收

2026-10-12，macOS ARM64。本记录覆盖 PR #130 / Owner PR #20 的安装界面跟进；Owner 固定提交为 `2036b599318267b7a28775ff614915da21ad6fcf`。测试前固定锁安装并重新构建 renderer，未把历史五域截图作为当前证据。

## 实际变更

- 当前目录只提供 Chip、PCB、Godot、CAD。Owner 的撤下声明过滤安装、项目选择、运行环境及资源配置入口；已有 CUDA 数据与独立运行契约保留，第三方领域不受默认目录白名单限制。
- 领域间增加边界；默认一句中文用途，执行要求折叠。重复说明和相同依赖原因去重。
- 依赖名称、状态和错误可见：绿色就绪、黄色待准备、红色检查失败，中性色未检测／不支持。失败的新检查覆盖旧的绿色显示，保留原关联数据。
- Pack 安装不要求 Docker；Godot、FreeCAD、限定 KiCad 原生方案无需 Docker。Chip、PCB design、DXF 容器方案仍要求 Docker。本次没有将这些复杂工具链迁移为本机执行。

## 本轮结果

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| Owner 全套测试 | 85 通过，2 个 opt-in 原生资格项跳过 | 含独立 CUDA HTTP/stdio 契约；不代表实际 GPU 服务 |
| Owner 架构与内容锁 | 架构 11/11，锁检查通过 | 同一固定提交 |
| Host 架构 | 47/47 | 包含架构契约，未放宽策略 |
| Host 发行契约 | 18/18 | 使用与新 Owner 一致的 Go probe index |
| Desktop Node 测试 | 53/53 | renderer 构建及 TypeScript 通过 |
| 目录与历史 CUDA 兼容 | 6/6 | 默认不提供、旧安装可读、配置策略不被删除、第三方仍允许 |
| 工业核心集成 | 9/9 | 真实 RTL、失败断言、取消、CLI/Kimi 与持久记录 |
| 真实 Electron 环境流程 | 20 项通过 | 使用明确标注的应用／远程 fixture；生产 IPC、绿色／黄色／红色、旧状态失效、暗色窄窗口 |
| 当前四域真实发行目录 | 源码和打包应用均通过 | 空 store 安装四域，无隐式软件准备事件，中英文截图，无 CUDA 行 |

表中套件有重叠，不将它们相加宣称独立 case 总数。另一 Agent 的完整安装任务书仍有 36 个验收项，本轮没有把它们全部执行一遍。

核心测试首次失败源于新固定提交路径下缺少测试用 Python 环境，以及旧 probe index。按已有 CI 方式准备固定 Python 依赖、使用新 probe 后，9 项完整通过。未修改工程验收断言。该 Python 环境是本机测试前置，不是给 Pack 用户新增的安装步骤。

## 证据

- [精简四域中文列表](qa-evidence/domain-install-ui-20261012/00-four-domain-catalog-zh.png)
- [实际领域依赖与分区](qa-evidence/domain-install-ui-20261012/05-capability-center-zh.png)
- [绿色就绪，fixture](qa-evidence/domain-install-ui-20261012/01-associated.png)
- [黄色缺失与旧关联保留，fixture](qa-evidence/domain-install-ui-20261012/02-missing.png)
- [红色检测失败，fixture](qa-evidence/domain-install-ui-20261012/02b-detection-failed.png)
- [暗色窄窗口，fixture](qa-evidence/domain-install-ui-20261012/04-project-dark-narrow.png)
- [20 项环境报告](qa-evidence/domain-install-ui-20261012/environment-report.json)、[源码目录报告](qa-evidence/domain-install-ui-20261012/source-catalog-report.json)、[打包目录报告](qa-evidence/domain-install-ui-20261012/packaged-catalog-report.json)。同目录保留本轮测试日志。

本地候选为 `dist/desktop-release-domain-ui/mac-arm64/Industrial Agent Harness.app`，使用应用自身 `Contents/Resources/bootstrap-packs` 执行安装回归，没有替换发行目录。未更新用户已安装的应用，也未签名、公证或发布安装器。

## 复跑

从当前固定 Owner 构建新的 probe 目录，并将 `HARNESS_PLATFORM_PROBE_INDEX` 指向对应 `platform-probe-index.json` 后运行发行／核心集成测试；不得使用旧 Owner 的 probe。环境 UI 使用 `--runtime-environments-selftest`，当前目录使用 `--release-catalog-selftest`。后者需要 `HARNESS_RELEASE_CATALOG_BUNDLED_DIR` 明确指向待测应用实际随附目录，报告与 store/config/userData 均使用新目录。

完整步骤与逐项判据见 [Agent 安装验收任务书](agent-install-acceptance.md)。实际 GPU 服务、所有软件冷下载、Windows/Linux GUI 与公众分发仍不在本轮覆盖范围内。
