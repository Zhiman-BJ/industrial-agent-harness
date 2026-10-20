# Kimi Code 原生机制兼容性审计

> 2026-10-20 执行政策更新：本页保留当时实现与验收记录。文中本机 Agent 的 Seatbelt/bubblewrap、工程只读或平台拒绝启动要求已由 [PD-088](local-agent-execution.md) 取代，当前三平台 Agent 均使用当前用户权限；声明式 Runtime 任务及远端沙箱隔离保持。历史实测结果不改写，也不代替新模式的平台验收。

2026-10-04，基于 Industrial Agent Harness 主分支 `371b011`，对照实际安装的 Kimi CLI 1.51.0 和 SDK 0.1.8。审计覆盖共享 Agent 适配器、Desktop 和 CLI 调用方、会话存储、模型配置、MCP 配置、执行隔离、事件与取消流程，以及 Kimi 对应源码。真实运行验证在 macOS Apple Silicon、Node 26.10.0 上完成。

项目技能遗漏来自工作目录替换。沿着同一边界检查，确认了 **9 项兼容性差异，其中 4 项接入缺陷在本次修复，另 5 项仍存在**。后者包含无意破坏，也包含已记录的产品限制。源码扫描和受控运行能够确认这些接入行为，不能替代真实模型能力评测、子 Agent 全流程或跨平台发行验收。

## 已修复的接入缺陷

| 发现                          | 原因与实际影响                                                                                                                                                                                  | 修复及验证                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 项目技能未被发现           | Kimi 的 cwd 被改成 session workspace，扫描的是会话目录。原项目 `.agents/skills` 等目录消失；`.skill/` 和 `.skills/` 本来也不是固定 CLI 的默认路径。                                             | 映射标准项目技能目录，将两个别名目录以绝对路径加入 `extra_skill_dirs`。真实 Provider 请求验证技能摘要出现，正文在 ReadFile 后出现，同名技能沿用原生优先级，坏 YAML 不阻断会话。 |
| F2 项目指令未被自动加载       | Kimi 的 `load_agents_md` 从 cwd 的项目根查找。Prompt 中告知原项目地址不会让原项目 `AGENTS.md` 自动进入系统提示。                                                                                | 映射所选 Project 根的 `AGENTS.md`、小写 fallback 及 `.kimi/AGENTS.md`。真实请求验证两类指令都进入系统提示。                                                                     |
| F3 原项目的绝对路径搜索被拒绝 | `project/` 链接和绝对 Project 地址没有加入 Kimi 的 `additional_dirs`。Glob 按工作区范围检查原项目路径，返回 outside the workspace。                                                             | 启动包装器使用 Kimi 原生 `--add-dir` 登记 Project 的规范绝对路径。真实 Glob 找到 RTL 文件，原进程写入限制继续生效。                                                             |
| F4 继承环境重定向原生会话     | Sandbox 将整个宿主环境传给 SDK；SDK 0.1.8 合并顺序是 shareDir 后覆盖 env。宿主 `KIMI_SHARE_DIR` 可以覆盖 Harness 指定的会话目录，导致配置、日志和上下文指向其他目录，甚至在隔离边界外启动失败。 | Sandbox 环境固定 `KIMI_SHARE_DIR` 为实际会话目录。故障注入中，旧实现在调用模型前失败；修复后正常启动。                                                                          |

实现位于 `packages/agent-kimi/src/project-workspace.cjs`、`prepareSessionFiles` 和 `createProcessSandbox`。Desktop/CLI 已有消费者使用同一适配器，无需两份扫描逻辑。技能解析、摘要生成、正文读取与优先级仍由 Kimi 完成；没有复制技能内容，也没有重新实现技能运行时。

映射刷新发生在创建或重开原生进程时。升级后的 workspace 版本进入兼容键，旧聊天首次运行会开始新上下文段并保留旧历史。活跃进程没有技能热刷新。`.skill/` 和 `.skills/` 是 extra scope，低于 Kimi 原生项目及用户 scope；这些本地技能不自动注册工业工具，也不进入 Broker 默认技能的启停清单。

## 仍存在的兼容性差异

### F5 输入包装阻断原生斜杠命令

**优先级 P1，已实测，未修复。** `KimiSession.run` 将每次输入包装成 Industrial Context、Project 提示和 `User task:`。Kimi 在 `KimiSoul.run` 中只将以 `/` 开头的完整输入送入斜杠命令解析器。因此 `/skill:name`、`/flow:name` 和 `/compact` 会变成普通用户文本。

对照实验中，直接调用原生 SDK 的 `/skill:audit-native-guide` 会把技能正文送入模型；Harness 即使已发现该技能，仍只把命令当作文字，正文没有进入请求。模型可能自行读取技能，但这不能替代原生命令执行。相同包装还会改变依赖原始输入的 Hook 匹配和原生会话标题。

建议将可信 Harness 上下文与原始用户输入分开传递，验证固定 SDK 可用的原生配置或扩展入口，再测试 skill、flow、compact、问题和图片输入。不能用正则在 Harness 中模拟命令，也不能为了放行命令删除工业权限检查。

证据：[原有输入包装](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/371b011/packages/agent-kimi/src/index.cjs#L516)；安装版 `kimi_cli/soul/kimisoul.py` 中的 `parse_slash_command_call` 和 `_make_skill_runner`。

### F6 宿主模型环境覆盖界面声明

**优先级 P2，已执行上游函数验证，未修复。** 对 Kimi provider，继承的 `KIMI_MODEL_MAX_CONTEXT_SIZE` 和 `KIMI_MODEL_CAPABILITIES` 会由原生 `augment_provider_with_env_vars` 覆盖生成的 TOML。Harness 的 profile、能力校验、诊断和会话兼容键仍基于原声明，没有把这些实际覆盖值纳入。

实测将上下文声明为 262144，环境设置为 16384，并把能力设置为 `video_in` 后，上游解析结果是 16384 和 `video_in`，原来的 thinking/image 能力被替换。该发现针对 Kimi provider；不能据此声称 OpenAI-compatible provider 使用同样的上下文覆盖。

建议明确 profile 与环境的优先级，拒绝或显示冲突，并让实际解析后的模型配置参与诊断和兼容键。保持明确支持的用户环境覆盖，比静默产生两套模型状态更可检查。

证据：[会话环境构造](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/371b011/packages/agent-kimi/src/model-config.cjs#L91)；安装版 `kimi_cli/llm.py` 的 `augment_provider_with_env_vars`。

### F7 生成配置和私有 share 目录隔断原生配置继承

**优先级 P2，源码确认的产品兼容性限制，未改变。** Harness 生成单一 `industrial` provider/model 的 TOML，并生成仅含选中服务的 `mcp.json`。它不读取用户原来的 Kimi 配置。原生 Hook、loop control、技能合并设置、自定义模型别名和自定义 Agent 配置不会自动继承。原生插件由 `get_share_dir()/plugins` 查找，所以 `~/.kimi/plugins` 也不会随着私有 share 自动加载。原有 OAuth 及会话数据同样没有自动迁移入口。

这里要区分两种技能来源：用户 `.kimi/skills`、`.agents/skills` 等目录由原生用户技能发现继续处理；安装在原生 plugins 目录中的技能和工具不是同一条路径。本次修复没有把原生插件目录或全局 MCP 直接连接进工业会话。真实受保护会话仍明确拒绝当前未纳入 Runtime 的外部 MCP host 服务和 Harness 应用控制插件。

建议声明一份配置兼容清单，逐项支持可继承设置；涉及进程、Hook 或外部服务的能力经过现有执行政策接入。全量链接 `~/.kimi` 会同时引入凭据、插件执行和 MCP，不能作为兼容性修复。

证据：[配置生成](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/371b011/packages/agent-kimi/src/model-config.cjs#L78)、[MCP 配置写入](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/371b011/packages/domain-mcp/src/index.cjs#L62)；安装版 `kimi_cli/config.py` 和 `kimi_cli/plugin/manager.py:get_plugins_dir`。

### F8 Scope 切换以新会话替代连续上下文

**已实测的预期设计，不计入待修复缺陷。** 有效 domain、stage、capability、skill 或 tool 集合变化，会关闭原进程，并通过不同 compatibility key 创建新 session ID 和 share 目录。旧聊天消息与原生目录保留，模型下一轮不再得到旧段的对话。模型、审批模式、插件或 MCP 变化也会触发相应重建。

真实测试只修改 stage、保持工具集合不变：session ID 改变，第二次模型请求没有第一轮记忆标记，界面能收到 context-reset。保持新 Scope 再运行一轮，记忆继续保留。这里没有发现 UI 历史被删除；问题是“聊天仍在”与“模型仍记得”之间有差异。

这已由现有文档记录，不能简单归类为未知 bug。后续应验证原生同一会话恢复与工具重新初始化能否安全保留上下文，同时替换当前 Scope。执行边界仍以新的 allowlist 校验，不能把保留历史误当作旧工具仍被授权。

证据：[Scope 与兼容键](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/371b011/packages/agent-kimi/src/index.cjs#L380)、[ChatStore 创建运行时会话](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/371b011/packages/harness-core/src/chat-store.cjs#L260)。

### F9 cwd 与项目根语义仍不等同于原工程

**优先级 P2，部分实测、部分源码推断的隔离取舍，未完整解决。** `--add-dir` 恢复了绝对路径搜索，但不会改变 Shell 的 cwd、ReadFile 的默认相对路径、目录列表或原生 Git 工作区判断。`npm test`、`git status` 或 `ReadFile("src/main.ts")` 仍从 session workspace 开始；提示中的原项目地址不能改变这些默认行为。

安装版 `collect_git_context` 的实测显示：在测试 Git 项目中有上下文，在隔离 workspace 中为空。源码还表明，Kimi 从最近 `.git` 祖先发现项目根，并沿根到 cwd 加载指令；本次仅映射选定 Project 根文件。因此绑定仓库子目录时，祖先 AGENTS 与仓库根技能的发现语义仍不等价，这一点是源码推断，没有完成独立 monorepo E2E。

工业 Project 只读是已有的明确限制。原生 WriteFile、Shell 工程修改及子 Agent 工程修改会被拒绝，当前仅已接入的宿主 Runtime 能做授权工业变更。后续要把“原生工程位置”与“可写临时位置”作为显式接口接入，验证目录、Git、祖先指令和工具路径；避免只靠每轮自然语言提示补偿。

证据：[隔离工作目录](https://github.com/Zhiman-BJ/industrial-agent-harness/blob/371b011/packages/agent-kimi/src/process-sandbox.cjs#L44)；安装版 `kimi_cli/utils/path.py:find_project_root`、`tools/shell/__init__.py`、`subagents/git_context.py`。

## 已检查的原生流程和未验证范围

| 原生机制                | 本次检查结果                                                                        | 证据边界                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent 循环与工具执行    | SDK 创建原生 Kimi，会话循环未被 Harness 重写；宿主工业工具再次校验 Scope。          | 真实 RTL、拒绝、超时、取消和原生 Shell 绕过测试通过。                                                                                             |
| 会话持久化与恢复        | 兼容时沿用原生 session ID；原生 context/wire 被读取并另存诊断副本，没有覆盖原文件。 | 三轮跨 CLI 进程恢复、空闲回收、SIGKILL 后恢复通过；跨 Scope 延续未实现。                                                                          |
| 上下文压缩              | 正常自动压缩仍由 Kimi 执行；Harness 监听压缩事件与读取检查点。                      | 本次没有重新执行长上下文自动压缩压力实验。人工 `/compact` 被 F5 阻断。                                                                            |
| 审批与提问              | 原生批准、拒绝和问题通过固定 SDK 转发；auto 对应原生 yolo。                         | 真实 Wire 提问、重复提交和异常停止测试通过；工业只读边界不因 yolo 取消。                                                                          |
| 技能与资源              | 项目摘要发现、正文按需读取和原生同名优先级保持。                                    | 根目录路径已实测；活跃技能热刷新和 monorepo 祖先语义未实现。                                                                                      |
| 图片、工具输出与日志    | 图片经原生多模态传入；界面截断和诊断副本脱敏没有截断模型的原生消息。                | 两种 Provider 图片链路、原生历史和输出配对测试通过。                                                                                              |
| 并行、停止、空闲回收    | 宿主调度围绕原生会话工作，没有替代原生 Agent 循环。                                 | 并行原生会话、跨进程额度、异常停止与另一个会话继续运行通过。                                                                                      |
| 原生子 Agent 与后台任务 | 审阅了 Kimi 的 runtime copy、builder 和 git-context 路径；未改写其运行时。          | 未启动原生子 Agent E2E。Wire external tools 只在根 toolset 注册，子 Agent 对 Harness 工具的继承及事件展示需要专项验证，不能据根会话通过宣称支持。 |
| Wire 扩展与界面展示     | 原始事件写入日志，界面只处理已接入的事件集合。                                      | Plan mode、steer、Hook 订阅和部分子 Agent/重试/MCP 加载事件没有完整产品入口；属于接入覆盖缺口。                                                   |
| 原生插件和用户配置      | 明确检查了配置生成、share 路径、plugin 查找和模型环境覆盖。                         | 已确认差异，未运行任意用户插件、Hook、OAuth 或外部服务。                                                                                          |

## 实际验证与后续顺序

本次完成 13 个受控探针：原生 SDK、原始 Harness 和修复版各 4 类对照，以及 Scope 变化的真实会话试验。探针观察实际 Provider 请求，使用本地模型协议响应和测试工程。原版技能/指令遗漏、搜索拒绝及 share-dir 启动失败都已复现；修复版通过。斜杠命令的正文加载差异仍存在。

Agent 包 45 项测试通过且无跳过，包含真实图片、并行、项目发现与进程写入边界；工业/恢复/提问/资源/异常停止 13 项通过且无跳过，包含真实 Verilator 和安装态 Pack 库存校验；架构检查 12 项、CI 结果判定 2 项与 Pack 发行检查 17 项通过。全仓 portable gate 通过 205 项，唯一跳过的是预先允许的可选 KLayout Viewer 测试。上述套件有部分覆盖重叠，不累加为独立用例数。Windows/Linux 工业 Agent 和目标平台安装包没有在本次验证。

后续优先修复 F5 的输入语义；再定义 F6/F7 的实际配置优先级与继承政策，以及 F8 的连续会话策略；最后验证 F9 的目录语义和子 Agent 接入。每项都应有“原生 SDK 对照 Harness”的契约测试，覆盖失败情形，继续保留工业执行权限和验收边界。
