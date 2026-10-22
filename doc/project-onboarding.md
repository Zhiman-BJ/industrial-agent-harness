# 项目创建与领域引导

项目旁的「+」与欢迎页「新建项目」使用同一流程：选择本地目录、填写名称、确认领域。默认选择内置「通用」，零 Pack 安装时也能创建项目并通过共享任务服务执行基础文件任务。模型连接仍需按既有流程配置。

## 可观察行为

- 通用领域始终包含在未绑定固定领域的 Core 注册表中，带 `builtin: true`；不计为已安装 Pack，不提供卸载/修复，不获取 Pack 使用锁。Desktop、通用 CLI 与共享任务服务使用同一注册信息。
- 已安装专业领域可直接选择。新增项目中的「安装领域包」打开现有安装管理器，暂时隐藏创建弹窗，保留目录、名称和原选领域。
- 安装成功后返回草稿并选中本次安装的一个领域；多选安装时其余领域同样可用。关闭、取消或安装失败时仍可返回原草稿，错误和重试继续由安装管理器处理。
- 初次启动可以选择「使用通用领域继续」。安装目录未配置、网络失败、平台暂不支持某 Pack，都不应迫使用户安装专业领域才能开始。
- 项目详情仍是后续切换领域的唯一入口；切换沿用原有会话隔离。专业领域工具只有在对应 Pack 安装并通过原有校验后才加入领域能力。
- 创建按钮要求有效名称、目录和当前注册表中的领域。创建期间禁止重复提交和修改表单。沿用共享弹窗焦点管理，保持 Tab 焦点循环、Escape 关闭和关闭后焦点恢复，小窗口下正文滚动、底部动作保持可见。

固定领域 CLI 分包保持原绑定，不扩展成通用发行版。通用工作区仅复用现有 Runtime，不新增领域实现、验证器或外部软件安装路径；文件写入仍遵循审批和哈希检查，不等于工程验收。

## 验证入口与边界

- `node --test packages/harness-application/tests/task-service.test.cjs`：空的真实 managed Pack store、Desktop TaskService、基础文件 Action、无专业工具泄露、非法领域拒绝。Agent 内核使用受控测试替身，不调用真实模型。
- `pnpm --filter @industrial-agent-harness/desktop test:ui`：已有专业领域、通用默认选择、安装入口往返与草稿保留。
- 构建后运行 `pnpm --filter @industrial-agent-harness/desktop test:project-onboarding`：真实 Electron renderer → preload → IPC，空安装通用创建、失败下载、重试安装、领域回填、深浅色和 640 × 480 布局。使用隔离用户目录和签名测试 Pack，不下载专业软件。可设置 `INDUSTRIAL_UI_SCREENSHOTS` 保存截图。

2026-10-16 本地共享任务测试、类型检查和构建通过。Electron 44 在当前执行环境启动时 SIGABRT，原生 UI 自测尚未完成，不据此宣称打包或跨平台验收通过。架构检查器通过；候选源码物化测试出现现有 `spawnSync git ENOBUFS`，在未修改的旧工作树复现，未改动检查器或策略。

完整 industrial-core 原生集成测试在本机未通过：缺少 Chip Pack 的 Python venv（状态检查退回基础工作区，专业工具未进入 scope），且本地模型测试服务监听返回 EPERM。因此本次不宣称专业领域原生执行链路已完成回归。

## 2026-10-19 复审

[跨平台 CI（30e5b86）](https://github.com/Zhiman-BJ/industrial-agent-harness/actions/runs/39208991507) 已通过 macOS 与 Windows 的项目引导、既有桌面 UI、打包及首启检查。引导验证涵盖空安装目录、General 创建、草稿保留、受控下载失败、重试和领域回填。修复后的测试在恢复宽窗口后再查询侧栏按钮，并通过设置入口改变主题，避免读取已卸载节点或让 React 重绘覆盖截图主题。

新建项目沿用共享弹窗焦点管理；General 的 CLI 集成测试位于 CLI 内，避免公开底层包新增对内部适配器的引用。与 CLI 归属修改组合后的 59 项本地定向/架构测试通过，架构例外额度未扩大。

本机 2026-10-19 的 Electron 启动仍在 macOS `NSApplication` / `_RegisterApplication` 阶段触发 SIGABRT；该失败不计为 UI 通过。上面的通过结论来自 CI 的真实 renderer → preload → IPC 路径。受控模型和签名测试 Pack 不构成专业软件执行资格，也不宣称修复了本机启动环境。
