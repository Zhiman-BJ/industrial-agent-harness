# DP：诊断与打包

本页区分 **main 已有诊断读取与安装包验证**、**手工收集 QA 证据**、**尚未合并的一键诊断打包**。#209 在远程分支、未进入本次 main 基线；不把该 PR 的按钮、导出格式、脱敏或 IPC 作为已交付能力，也不从中运行脚本。依据：[CI 回归](../ci-regression.md)、[CLI](../../apps/cli/README.md)、[安装体验](../install-experience.md)、[版本边界](../editions.md)。

## 自动命令

```sh
node --test packages/agent-kimi/tests/diagnostic-log.test.cjs packages/agent-kimi/tests/diagnostic-reader.test.cjs packages/agent-kimi/tests/diagnostic-view.test.cjs apps/cli/tests/inspect-log.test.cjs apps/cli/tests/doctor.test.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:logs
```

当前 CLI 有 `doctor`、`inspect-log` 和 `run --log-dir`；Desktop 日志面板只读查看运行、分页、过滤、上下文及工具详情。main 没有“一键导出脱敏诊断包”的产品入口。产品命令示例：

```sh
node apps/cli/src/main.cjs doctor --project-dir /path/to/project --domain DOMAIN
node apps/cli/src/main.cjs inspect-log --file /path/to/diagnostic.jsonl
```

doctor 需要相应 Pack/工程准备，会走共享诊断任务路径，不是只有读取文本；在专用工程执行。inspect-log 输出 projectDir、Scope、快照等内容，**不是脱敏导出器**，输出须本地审阅后再分享。

实际应用打包/安装按 [T5](tiers.md) 和 Linux [T6](tiers.md)；不能由 `build` 通过推断安装成功。追加 headless 生产进程边界：

```sh
node --test tests/integration/headless-package-kimi.test.cjs
```

需要 T4 固定 Kimi 前置。版次与公开清单另执行 `pnpm test:editions`，它检查机器清单/边界，不代替签名、公证或 OTA 验收。

## 手工矩阵

| ID | 步骤与预期 | 边界／失败恢复 | 必留证据 |
| --- | --- | --- | --- |
| DP-01 诊断读取 | 执行专用任务后打开日志；按运行/类别搜索，分页，展开长工具输入输出/上下文，运行中刷新 | 绑定当前项目，不能读其他项目；无日志、缺 run.end、损坏记录、缺失工具返回如实提示，不编造完成 | trace/run ID、分页/详情截图、错误或不完整状态 |
| DP-02 CLI 关联 | 同任务保留 JSONL，inspect-log 检查 schema/trace/sequence，关联 ToolCall/ToolResult、compaction/snapshot 与终态；doctor 查看真实依赖错误 | 缺序/混 trace 应失败；doctor 诊断不等于工程通过，退出码不代替 Verification | 脱敏摘要、退出码、完整性判据与关联 IDs |
| DP-03 QA 证据收集 | 在本 run 目录保存完整 SHA/dirty、锁定依赖身份、平台/版本、每层日志/原始 suite JSON、截图、模块结果和缺口；形成清单后检查可读与归属 | 不复制其他会话报告，不收集真实凭据/配置秘密/原始私有对话；需要移交时手工审查最小材料；原始现场单独保留 | 清单、每项来源与范围、SHA-256、脱敏审查结论 |
| DP-04 产品包 | 保存源 SHA、dirty、owner pin、包大小/hash；实际安装首启，隔离 profile 选择域并执行目标平台已声明流程 | macOS unsigned、Windows dir、源码 Electron 各自独立标注；签名/公证/OTA 没执行就是未验收；旧数据升级另用专用升级 gate | 包身份、首次启动截图、receipt、持久化/修复结果 |
| DP-05 清理 | 所有结果写完先运行 cleanup 默认预览，检查审计清单与保留期 | 无候选不需要 apply；不得为清理删除 tracked/外来 WIP/活跃进程/锁；手工打包不触发自动上传 | preview 审计、若确有 apply 则保留第二份审计 |
| DP-06 #209 后续 | 当前仅记录“未合并”；将来以实际合并 SHA、产品入口、文件库存与权限契约新建验收 | 当前没有可宣称通过的一键诊断导出用例；不能把手工压缩证明成产品功能 | 未覆盖项及所属 PR；不伪造测试命令 |

## 自动覆盖缺口

T1/T2 已有日志读取与秘密字段保护测试不证明完整诊断包已去敏；手工材料也不能自动归档私人日志。#209 未合并，因此无可运行的 main 诊断包自动验收入口。真实打包安全存储、签名发行、Core OTA 和其他 OS/架构安装仍遵守各自明确范围。cleanup 先预览，不把清理成功当成 QA 通过。

[返回矩阵](modules.md)
