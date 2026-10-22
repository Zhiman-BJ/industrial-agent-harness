# 本地聊天与会话恢复

聊天持久化由 Desktop 使用。2026-10-05 起，模型上下文由固定的 `@moonshot-ai/kimi-code@2.1.1` 保存和恢复；Harness 不重写 Kimi 的 Agent Loop、压缩或上下文文件。

## 存储与边界

默认目录是 `~/.industrial-agent-harness/chats`，可通过 `INDUSTRIAL_HARNESS_CHAT_DIR` 覆盖。数据库和目录分别限制为 0600、0700。

- `chats.sqlite` 保存产品侧聊天、项目真实路径与 Domain、标题、每轮原始用户任务、Broker 结果及展示事件。
- `runtime_sessions` 保存不透明的运行时 ID 与兼容性键；Kimi 适配器在私有 `harness-native-session.json` 中把该 ID 映射为原生 `session_*` ID。兼容性键包括内核与版本、有效 Scope、模型配置、执行入口和 MCP 禁用策略，不包括 API key。
- `sessions/<runtime-id>/` 是该运行时自己的 Kimi share directory，包含配置、Scope Skill/MCP、Kimi 原生上下文、事件文件及其他恢复材料。关闭聊天或应用保留整个目录；删除聊天清理其索引、展示记录和运行时目录。
- 工程文件观察、Checkpoint 仍在既有 `state/` SQLite 中；完整诊断日志仍在 `logs/` 中，删除聊天不会删除诊断日志或工程 Checkpoint。聊天内容与运行成功不构成工程 Verification。

同一个界面聊天可关联多个运行时会话段。工具或模型变化产生新段时，消息流会提示上下文重新开始，旧消息仍可查看。只有有效 Scope、模型配置和运行配置兼容时才恢复最近的会话段；Scope/模型变化后建立新段，保留界面历史并注入当前 Industrial Context / Checkpoint，不把旧消息重新拼成 Prompt，也不跨段合并 Kimi 上下文。返回曾经使用过的 Scope 时也从新段开始，避免回到更早的上下文分支。

已初始化的会话缺少原生身份映射或消息 API 返回空历史时明确报错，保留聊天历史，提示创建新聊天；不悄悄用空上下文顶替。恢复时会重新解析 Broker，并应用当前 Project 和全局资源策略。已登记的 Skill 目录可重复准备；会话之间配置隔离。

## 用户操作

Desktop 在所属项目下显示历史聊天、新聊天和删除入口。启动或切换项目时读取最近聊天；点击另一聊天恢复其展示历史。每次先读取最近 10 轮，点击 Load earlier messages 继续向前分页。项目列表初始显示最近 200 个聊天。每轮发送后保留前面的消息；输入框清空，聊天自动跟随最新输出，向上阅读时保持阅读位置。

Desktop 的 New chat 优先复用当前项目、Domain 下未提交过任何轮次的空白聊天；当前聊天已经为空时禁用侧栏入口。切换回同一个空白聊天保留未发送的文字和图片。创建请求期间阻止重复点击，主进程通过共享 ChatStore 的事务查询/创建草稿，多个窗口或直接重复 IPC 请求也不会持续新增空白记录。有 scoped、失败或中断轮次的聊天都属于历史，不能按标题 `New chat` 判断为空；已归档或被执行锁占用的聊天不复用。现有重复空白记录保留，仍可手动删除。

## 中断与并发

SQLite 事务保存每轮状态和展示事件，流式文本/思考合并为展示记录；原始事件仍保存在诊断 JSONL。跨进程执行锁以聊天 ID 为单位，活跃的另一个执行者会被拒绝。进程死亡后，读取历史或再次运行时将遗留轮次标为 interrupted，并回收执行锁。历史审批在 UI 显示决定或过期，不恢复操作按钮；新请求只交给当前 Turn。恢复历史本身不发 Prompt、不调用工具、不重放工业动作。

新运行时使用独立 `KIMI_CODE_HOME` 与公开会话 API 恢复。旧 CLI 与新内核的兼容键不同，旧聊天展示保留，后续任务创建新原生上下文段并提示；不读取旧文件拼接 Prompt，不修改用户的 Kimi 全局目录。

## 验证

- `pnpm test`：共享存储、空白聊天复用与跨进程并发创建、隔离、分页、持久会话与应用层行为测试，以及已有回归检查。
- `pnpm test:architecture`：共享 Core 不依赖 Kimi/Electron，执行与领域边界不变。
- `pnpm test:chat-resume`：真实固定 Kimi Code 2.1.1、多个独立应用层测试进程、本地可控 OpenAI 兼容端点；验证第三轮请求带前两轮上下文、换模型建立新段、SIGTERM 中断后原上下文可继续。没有使用远端模型或用户 API key。运行时随依赖安装，该项默认执行。
- `pnpm --filter @industrial-agent-harness/desktop test:chats`：两次真正启动/退出 macOS Electron，使用确定性 SDK seam 验证历史恢复、第三轮续聊、聊天切换、快速连点与 IPC 空白聊天复用、重载与未发送草稿保留、消息分页、删除、过期审批和跨项目拒绝，并保存截图。
- `pnpm --filter @industrial-agent-harness/desktop test:logs`：已有诊断日志、资源配置、实时审批和压缩事件 UI 回归。

验证覆盖本地 macOS 开发运行；不宣称 Windows/Linux 发行包或真实工业动作的崩溃恢复已验收。持久聊天不替代 Industrial Core Vertical Slice 的工程状态、Run/Action、Verification 验收。

图片附件沿用主分支的输入校验与模型能力判断，用户图片作为展示事件保存在聊天历史中；重新打开应用仍可查看原始附件。图片仅作为用户参考，不构成工程事实。
