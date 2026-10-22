# WB：工作台、项目与聊天

依据：[产品决策](../product-decisions.md)、[聊天持久化](../chat-persistence.md)、[并行 Session](../parallel-sessions.md)、[窗口布局](../desktop-layouts.md)、[语言](../desktop-languages.md)。执行前先走[协议](protocol.md)，使用临时工程、隔离配置与独立截图目录；源码 UI 测试必须先 build。

## 自动命令

```sh
node --test apps/desktop/electron/project-bindings.test.cjs apps/desktop/electron/chat-history.test.cjs apps/desktop/electron/session-manager.test.cjs apps/desktop/electron/modal-focus.test.cjs packages/harness-application/tests/task-service.test.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:ui
pnpm --filter @industrial-agent-harness/desktop test:chats
pnpm --filter @industrial-agent-harness/desktop test:parallel
pnpm --filter @industrial-agent-harness/desktop test:language
pnpm --filter @industrial-agent-harness/desktop test:messages
pnpm --filter @industrial-agent-harness/desktop test:browser
```

这些定向单测属于 T1；ui/chats/parallel/language 进入现有 CI。messages/browser 虽有脚本，当前 workflow 未直接调用。真实固定 Kimi 的恢复、后台和资源门禁走 T4（不能用普通 UI fixture 代替）：

parallel 另覆盖真实 Renderer 强制崩溃后由测试显式 reload，再检查历史/终态去重和新任务可执行；这是受控恢复路径，不宣称产品自动自愈，也不覆盖 Electron main 崩溃。详细指标与故障边界见 [PF 模块](performance-recovery.md)。

macOS 的 `test:ui` 另覆盖三轮真实窗口关闭/销毁后发送 Electron `activate` 事件：检查仅创建一个新窗口、项目与聊天选择及 IPC 可用、应用服务复用、显示监听无累积、最小化恢复，以及退出时不复活窗口。该自动测试验证 Electron 事件链，实际 Dock 点击仍按 WB-08 单独记录。

```sh
pnpm test:chat-resume
pnpm test:session-resources
pnpm test:session-chaos
```

后面三条须先完成 T4 的 Kimi/领域工具准备；输出单独记录，不等于 native 全 suite 成功。

## 手工矩阵

| ID | 步骤与预期 | 边界／失败恢复 | 必留证据 |
| --- | --- | --- | --- |
| WB-01 首次工作台 | 新配置打开，检查左右栏可折叠、工作区与文件树默认收起；浅/深色及中/英/跟随系统切换，640×480 检查内容可达；重开保留偏好 | 文本裁剪、不可见按钮、横向溢出为失败；恢复正常窗口后仍须复现最小窗口 | 首屏、主题与小窗口截图、偏好恢复记录 |
| WB-02 项目绑定 | 用专用空目录创建项目并选领域；新聊天显示只读领域；详情修改领域后新 scope，切换项目只见各自文件 | 设置只含全局项；不在 composer 添加领域/阶段选择；拒绝越过所选项目的文件请求 | 项目 ID/规范路径、领域与 Scope、拒绝错误 |
| WB-03 草稿/历史 | 两聊天各输入草稿并来回切换；发送任务后重启，恢复原 chat/native 身份与结果；停止后继续同一聊天 | 取消、异常退出后不假装完成；正在执行与历史记录分开，保留失败与已有成果 | chat ID、会话段、取消/恢复事件、历史截图 |
| WB-04 并行与审批 | 同项目、跨项目各开两个聊天；后台收到问题/审批，切换可处理；只停止目标聊天 | 运行中配置修改按现有忙时限制拒绝或约束；不得取消其他 Session，达到额度应明确排队/拒绝 | Session IDs、审批/停止时间线、活跃资源数 |
| WB-05 弹层键盘 | 从按钮打开模型、项目、账号等弹层；Tab/Shift+Tab 进出首尾、Esc 关闭、焦点返回入口；输入法 composing 时 Esc 不误关闭 | 背景不可被 Tab 聚焦；嵌套弹层只关闭最上层；不要把合成键盘事件等同 OS 输入法实测 | 每种弹层的键盘结果、失败焦点目标、小窗截图 |
| WB-06 消息流 | 观察实时 Thinking 数行、结束默认收起、工具调用和结果同一折叠项、审批可见；查看 Broker 展开详情与复制/悬停行为 | 未完成调用不得显示虚构返回；消息变化不抢用户编辑焦点，历史重载不重复执行 | 工具/结果关联 ID、运行前后与悬停截图 |
| WB-07 工作区浏览器 | 打开浏览器页，导航/返回/标签切换，检查域名与安全状态；浏览器自动操作默认关闭，开启后 Agent 操作可见且可接管 | 网络页面内容不可信；本地 HTML 走断网沙箱；网页不能读项目文件或产生工业通过事实；不可逆提交另需用户授权 | 页面 URL、开关前后、操作诊断；不保存凭据 |
| WB-08 macOS 关闭与 Dock 恢复 | 点击红色关闭按钮后进程继续运行；点击 Dock 图标恢复一个可交互窗口；连续三轮后检查项目、聊天、账号及已有任务；最小化后点 Dock 恢复 | 关闭释放 Viewer 展示资源；重开不重复初始化服务。Cmd+Q/菜单退出及升级退出真正结束进程；Windows/Linux 关闭最后窗口仍退出。未发送的草稿与未保存的 Viewer 视图不承诺跨窗口销毁保留 | 应用/OS 版本、三轮前后 PID/窗口、实际 Dock 点击与 IPC 结果、退出结果；与自动事件测试分别记录 |

## 自动覆盖缺口

T2 多为受控事件和项目数据；不能证明真实模型长会话质量、跨平台窗口管理、原生输入法或真实网站流程。browser selftest 不等于八个 web_* 工具和 OS 层行为全覆盖；模态 focus 单测/合成事件通过后仍应检查真实键盘。T4 compaction 检查固定上游外壳兼容，不作为模型摘要能力 benchmark。

[返回矩阵](modules.md)
