# P0 工业运行时与执行边界

> 2026-10-20 执行政策更新：本页保留当时实现与验收记录。文中本机 Agent 的 Seatbelt/bubblewrap、工程只读或平台拒绝启动要求已由 [PD-088](local-agent-execution.md) 取代，当前三平台 Agent 均使用当前用户权限；声明式 Runtime 任务及远端沙箱隔离保持。历史实测结果不改写，也不代替新模式的平台验收。

状态：2026-10-04 的实际实现，macOS Apple Silicon（arm64）与 Ubuntu 22.04 x86-64 的验证入口。Linux 一键安装门禁见 `industrial-linux.yml`；Intel Mac 暂不支持。主仓自有贡献按用户选择采用 MIT，第三方边界见根目录 `THIRD_PARTY_NOTICES.md`。本页不声明其他领域、Windows 或 Linux ARM64 已通过工业验收。

`harness-core.createProjectRuntime` 从仓库注册或验签安装后的 `loadRegistry.runtimePacks` 加载 Pack 声明的 runtime entry。项目不能注入任意入口。领域实现与 Capability ID 留在 Chip Pack；通用 Factory、Broker、Kimi 与 Runtime 不硬编码领域。CLI 与桌面项目运行时缓存消费同一入口。

首条真实路径为：Project → Chip StateProvider（读取 eda.yaml/RTL/testbench 的内容摘要）→ 规范 DomainState → State 驱动 Broker → 固定 Kimi SDK 0.1.8 / CLI 1.51.0 → 宿主 industrial_action_call → Runtime 二次权限检查 → vendored EDA Harness 的 lint/simulate DAG → 真实 Verilator（启用 assertions）→ log/execution report/completion report/VCD → Chip assertion Verifier → 新 DomainState → 持久 Checkpoint。

Action 记录输入内容身份、实际 Verilator 版本、参数、Run/Action ID、诊断、产物与 Verification。Verifier 单独检查真实断言失败、completion marker、原生 verifier 和 VCD 结构。进程成功只决定执行状态；工程接受来自 Verifier。断言失败为 `failed`，编译失败/原生超时/取消/缺少证据为 `insufficient_evidence`。测试覆盖 Verilator `%Error` 与新版本 `%Fatal` 的断言输出。覆盖程度由真实 testbench 定义，不代表设计生产签核。

每次请求需当前 `expectedStateId`。Scope、项目/领域不符或未经批准时，Runtime 保存失败 Action、显式空产物集及不足证据，不启动原生工具。源输入变化保留旧验收、将当前状态置为 `stale`；执行中变化也不得建立当前接受。产物按 SHA-256 保存并再次核验；历史 Checkpoint 链和失败记录可在重开进程后查询。并发 owner 由 SQLite 事务租约拒绝；死亡 owner 的 running Action 恢复为失败。新版数据库被拒绝且不清除其原租约。

macOS 使用真正的 Seatbelt 进程边界：Kimi 及其 Shell/WriteFile/子进程只可写独立 session/scratch，实际 Project 与工业元数据只读。固定 CLI 启动时要求工作目录可写，所以 native cwd 使用稳定的 session `workspace`，其中 `project/` 是只读真实工程的符号链接；Prompt 明确两者含义。工程写入仍由宿主 Runtime 完成。native 历史按稳定 workspace 关联，新的边界版本参与会话兼容键。

会话还映射所选 Project 根目录的原生技能目录和 `AGENTS.md`，并追加 `.skill/`、`.skills/`，由 Kimi 继续处理摘要、正文和优先级。启动包装器通过原生 `--add-dir` 注册 Project 的规范绝对路径，并固定 `KIMI_SHARE_DIR`，恢复项目搜索且避免继承环境重定向会话存储。Seatbelt 的只读工程边界继续生效。剩余兼容性差异见 [Kimi 原生机制审计](kimi-native-compatibility-audit.md)。

Linux x86-64 使用 bubblewrap 的只读宿主挂载、独立 user/PID/IPC namespace 和删除 capabilities，仅重新挂载 session/scratch 为可写。继承的 seccomp 拒绝宿主 Unix socket 与 namespace/mount 重配置，避免经 Docker/D-Bus/SSH agent 绕过。模型 TCP/UDP 与子进程内部 socketpair 保留。bwrap、namespace 或过滤器不可用时直接失败。安装器先验证主机前提，安装后验证受保护 Kimi 启动。

Chip RTL Scope 另提供 `chip.environment.check`，通过同一 `industrial_action_call` 在宿主 Runtime 检查声明的 RTL 输入、工具及 Docker。该只读 Action 使用 `inputs: {}`，仍核对项目、Scope 和当前 State；结果位于 Action diagnostics，Verification 为 `not_run`。检查成功或失败均保留原工程 State、产物与验收身份，同时记录新的 Action/Checkpoint。Agent 的 Shell 和子 MCP Docker 拒绝属于预期边界，不能据此断言宿主 Runtime 故障。该入口要求已有 `eda.yaml` 和 StateProvider 确认的 RTL 阶段；工程初始化和文件编辑由共享 workspace Tools 承接；专业物理设计仍需领域实现。

遗留 Domain MCP 的修改继承只读边界并可见失败，不能靠 Prompt 放行。所有领域均可通过共享 Runtime 初始化、编辑工程和执行声明任务，专业验收仍需领域 Verifier。外部 MCP 已接入持久 Action/响应边界，独立应用控制插件仍不可用。Windows 工业 Kimi 执行仍在启动前拒绝。

实际验证入口：

```sh
node --test tests/integration/industrial-core-vertical-slice.test.cjs
node --test packages/agent-kimi/tests/process-sandbox.test.cjs packages/domain-runtime/tests/industrial-recovery.test.cjs
node --test tests/integration/license-materials.test.cjs
```

Core 集成测试使用真正的 CLI/Kimi 和本地确定性模型响应推动调用，随后执行真实 Verilator；不使用外网模型凭据，不将这些受控响应当成模型能力评测。CI 的 mandatory macOS gate 要求固定 CLI/Python 与 Verilator；没有安装不能以跳过替代通过。

取消与执行中输入变化的集成测试使用真实 Verilator 仿真中的就绪握手，取代固定延时。仿真通过测试专用后代进程通知已启动，并等待测试释放；取消用例检查仿真执行报告为 `CANCELLED`、仿真与后代均已退出、工程验证仍为不足证据。输入变化用例在收到就绪信号后修改源文件，再释放仿真，检查真实仿真完成仍不能建立当前工程验收。启动前取消另行检查无原生执行和空产物集；所有握手等待都有超时上限。

安装态 Pack 库存不可变：Python 桥接禁止生成 bytecode/cache，项目产物与 Core SQLite/CAS 放在包外。安装 `.hpack` 后，通过包外 `INDUSTRIAL_HARNESS_EDA_PYTHON` 指向按其 uv.lock 准备的 Python 环境；不能在验签后的 Pack 内创建 `.venv`。源码开发 checkout 的默认 `.venv` 仅用于开发。安装态集成测试实际执行 Verilator 后重新扫描库存、重开 Factory 与读取验收历史。

剩余边界：Runtime 插件属于可信代码，host 执行没有替任意第三方 Pack/恶意 testbench提供完整 OS 沙箱；网络、秘密读取也不在本次写入边界内。共享 workspace Tools 已提供授权文件修复和声明任务检查；FreeCAD 有自己的 Verifier，共享检查不替代其他领域签核。主仓与 EDA Harness/demo 自有贡献已获 MIT 授权，但不能替代无授权外部 actor 或第三方二进制的源码/告示义务。三平台发行物和完整第三方依赖 SBOM仍需独立资格验证。
