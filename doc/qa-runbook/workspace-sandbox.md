# 真实声明式任务沙箱与输入绑定验收

本页只验收共享 Runtime 的声明式本地任务隔离与输入证据绑定。使用真实 Node 子进程和生产 task-process 后端：macOS arm64 为 Seatbelt，Linux x64 为 bubblewrap/seccomp。它不代表本机 Agent 已恢复 OS 沙箱，也不替代完整 native、Electron/MCP/FreeCAD、安装包或其他平台验收。

## 一次运行

在可启动子沙箱的本机终端、当前代码的仓库根目录执行（Node 24+、依赖已安装；无需模型 API key、FreeCAD 或 Docker）：

```sh
node scripts/verify-workspace-sandbox.cjs
```

脚本先通过生产后端在临时目录运行带随机标记的真实程序。若已知系统权限或隔离依赖问题阻止创建沙箱，立即写 BLOCKED，退出码 2；其他前置执行失败记为 FAIL，退出码 1。不能以测试未运行当作通过，也不能通过删除沙箱配置、mock 执行后端或放宽文件/网络限制来取得 PASS。

前置通过后严格执行下面 5 个已有 native 用例。只有全部实际运行且通过、没有 skip/cancel/TODO、用例身份完整、所记录源码在运行期间未改变，才输出 PASS 和退出码 0；其他测试失败为 FAIL 和退出码 1。受控测试只写临时 fixture，不读写用户工程，不使用模型凭据。

| 用例                               | 必须观察到的结果                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工程生命周期与并发编辑             | 创建→检查通过→编辑后 stale→失败→修复通过；历史产物仍可读。真实子任务暂停后从宿主修改 live source，旧副本检查仍通过，当前状态 stale；再运行必须验证新内容                           |
| 副本被外部修改（同属生命周期用例） | 宿主在子任务暂停期间修改副本，保持计算结果正确；子任务的真实检查报告通过，但 Runtime 必须记为 insufficient_evidence，不能获得 snapshot 绑定                                        |
| 写入、凭据与宿主连接边界           | 子任务不能写源文件、Runtime 数据库或输入副本；不继承凭据环境变量。宿主先成功连接 TCP/Unix socket 作为对照，子任务必须得到 EPERM/EACCES；连接超时、服务不存在或拒绝连接不算隔离通过 |
| 可读范围                           | 已复制输入、必要运行库和明确声明的依赖可读；未选工程文件与无关宿主文件不可读                                                                                                       |
| 验证语义                           | exit 0、没有 verifier、缺失/畸形报告、超时均不能冒充工程验收通过                                                                                                                   |
| 生命周期清理                       | 截止、取消、父进程正常退出后，本次拥有的父/子进程均退出并保存正确终态                                                                                                              |

## 结果与取证

每次运行使用新的 `dist/qa/workspace-sandbox/<时间>-<随机值>/`，保存：

- report.json：PASS/FAIL/BLOCKED、退出判据、五个用例结果、Node/OS/CPU、Git SHA/dirty、关键执行与测试源码/lockfile hash、真实前置执行记录。
- tests.log：原始用例输出；前置失败时没有该文件，因为 native 用例未执行。
- evidence/：临时 Runtime 清理前保存的 canonical Action、Verification、Checkpoint、Artifact 元数据，以及实际 execution/checks/log artifact 字节；使用 Artifact SHA-256 对照，不保存用户应用配置。

`dist/qa/workspace-sandbox/latest.json` 指向最近一次报告内容，原运行目录保留。若 Git dirty 为 true，报告只绑定已列出的工作区源码 hash，不能直接宣称某个干净提交通过。

2026-10-20 的受限工具环境已实测前置失败：`sandbox_apply: Operation not permitted`。申请宿主执行被审批策略自动拒绝（sandbox_approval=false）。该环境不能执行本页的真实通过验收，需要在允许创建子沙箱的本机终端运行并返回结果；不改变 Harness 的隔离策略。

同日本机终端运行已成功启动沙箱，但前置程序写入 `work/ran` 返回 EPERM，报告状态为 FAIL。定位为 macOS 写权限使用了 `/var/...` 别名，而实际文件路径是 `/private/var/...`；生产后端现将读写授权统一到工作目录的真实路径，并在原生用例中增加目录别名下实际写出结果的回归。配置生成回归已验证修复前失败、修复后通过；真实用例仍须重跑，不能将本次代码修复等同于原生验收通过。

该路径修复的定向回归 23/23 通过，架构契约 20/20、架构套件 48/48 通过，Lint 与 diff 检查通过。受限工具内重跑真实入口仍为 BLOCKED；本机终端的修复后真实通过结果尚待取得。

[返回 QA 入口](../qa-runbook.md) · [输入绑定范围](../evidence-input-binding.md)
