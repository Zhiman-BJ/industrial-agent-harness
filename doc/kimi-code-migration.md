# Kimi Code 2.1.1 迁移

> 2026-10-20 执行政策更新：本页保留当时实现与验收记录。文中本机 Agent 的 Seatbelt/bubblewrap、工程只读或平台拒绝启动要求已由 [PD-088](local-agent-execution.md) 取代，当前三平台 Agent 均使用当前用户权限；声明式 Runtime 任务及远端沙箱隔离保持。历史实测结果不改写，也不代替新模式的平台验收。

2026-10-05：Desktop 与 Headless CLI 共用 `agent-kimi`，运行时从 Python CLI 1.51.0 / npm Agent SDK 0.1.8 迁至 MIT 开源的 `@moonshot-ai/kimi-code@2.1.1`。固定版本和完整性由 manifest、pnpm lockfile 保证，服务启动时再次核对版本，关闭自动更新。

旧 [kimi-cli 仓库](https://github.com/MoonshotAI/kimi-cli) 于 2026-09-23 归档。[新仓库](https://github.com/MoonshotAI/kimi-code)公开源码；新 Node SDK 尚未发布至 npm，所以本接入使用官方公开的 [Server API](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai/kimi-code%402.1.1/docs/en/reference/server-api.md)。该 API 被上游标记为实验性，升级必须先通过固定版本契约测试。

## 接入边界

- 每个会话独立启动 `kimi web --host 127.0.0.1 --no-open`，使用私有 `KIMI_CODE_HOME`、随机 token、REST 与认证 WebSocket。执行与常驻额度继续由现有 Core 管理。
- Kimi 负责原生 Agent Loop、工具循环、Skill、压缩与持久化。Harness 只映射事件、身份和生命周期，不复制 SDK 或 fork 上游。
- 工业与外部 MCP 继续通过既有 Gateway；宿主 metadata 工具与插件回调经认证的本地 MCP 服务提供，执行时仍检查当前 Scope。启动等待所有已配置 MCP 连接；错误或超时明确失败，避免缺少工业工具却继续运行。
- `openai_legacy` 产品设置映射至新内核的 `openai` provider；密钥通过 `api_key_env` 注入，输出上限用 `max_output_size`。上游 Node.js 最低版本为 22.19；Harness 保留主分支的 Node.js 24 最低版本。
- manual 模式保留每次审批；Harness 的 auto 策略和已启用插件继续自动批准相应请求，问题仍需用户回答。单选、多选、自定义文本及主动跳过通过原生问题 API；非交互 CLI 保留问题并返回 `needs_input`（退出码 2），由宿主决定如何继续。停止优先调用原生取消，超时只关闭目标会话。进程死亡、事件断连或流缺口明确失败，不自动重提任务。

## 历史与诊断

兼容性键加入内核及版本。旧聊天展示、诊断和旧上下文文件保留；首次继续旧聊天建立新原生上下文段并提示。新上下文身份以 `harness-native-session.json` 映射，实际消息与恢复材料由 Kimi Code 管理。已初始化身份或原生历史缺失时报错，不悄悄替换为空上下文。

原生事件保存为 `kimi-code.event`，既有界面和历史诊断消费者继续使用映射的 `sdk.event`。新快照通过消息 API 获取，展示为“已保存对话”；它不等于完整模型上下文、系统指令或 HTTP 请求，也不推断每个模型步骤的上下文。旧 context/wire 快照只读解析仍保留。已知密钥、认证 token 和返回的图片载荷不进入诊断事件或快照。

## 验证

使用 macOS arm64、Node.js 26.10.0、固定 Kimi Code 2.1.1 与本地可控 OpenAI SSE 响应；不使用远端模型密钥。测试运行真实内核，模型响应只用于控制链路，不代表工业验收或模型质量。

- Agent 包回归和固定版本契约：Bash 批准/拒绝、参数完整性、Scope 撤销、双服务认证、启动失败、版本不符、启动中取消、并行隔离，以及两种 provider 的图片输入。
- `test:chat-resume`：多进程三轮恢复、模型切换创建新段、SIGTERM 中断后继续。
- `test:session-resources` / `test:session-chaos`：空闲回收、跨宿主额度、强杀后清理与恢复、另一聊天独立完成。
- `test:compaction-compat`：让真实内核自动压缩，检查事件映射、原生身份复用、后续模型请求和跨进程恢复；不评估摘要质量。
- `test:external-mcp`：真实 stdio/HTTP/SSE Gateway、拒绝后无 host 修改、截图进入模型请求。
- Chip MCP 测试使用独立固定 Python 环境，检查目标持久化和上下文回读；不执行芯片计算或 signoff。
- 架构边界、桌面构建、Headless 打包与包外运行使用既有验证入口。

初次迁移基线（对齐最新主分支前）：

| 检查                         | 结果                             | 范围                                                                                                 |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 全仓 `pnpm test`             | 189 项：188 通过、1 跳过、0 失败 | 唯一跳过为可选 Viewer 依赖；Agent 测试均运行                                                         |
| `test:architecture`          | 12/12 通过                       | Core/Broker/CLI 分层边界                                                                             |
| 真实内核集成                 | 11/11 通过                       | 五项提问场景、原生压缩兼容、跨进程恢复、资源额度、强杀恢复、外部 MCP、Chip MCP                       |
| Desktop 构建与格式检查       | 通过                             | TypeScript、Vite 与源码格式                                                                          |
| macOS Electron 聊天/并行回归 | 通过                             | 重启恢复、200 次切换、160 次同帧双击、审批/提问/Stop 隔离；使用受控会话 seam                         |
| macOS arm64 未签名 `.app`    | 通过                             | 首次启动、归档中的真实 2.1.1、认证 MCP 回调、Bash 审批与写入、提问跳过、跨原生进程恢复、Web 资源读取 |
| Headless 包外实际执行        | 通过                             | 无额外 Kimi 安装，随包真实内核完成一轮请求                                                           |

桌面发布流程增加 `node scripts/smoke-packaged-kimi.cjs`，在打包后实际运行原生内核。它在本地受控模型下检查宿主回调、审批、文件执行及恢复，macOS arm64 已实测；macOS Intel/Windows 的对应发布 gate 尚未在本次运行。未签名 `.app` 构建使用 Electron 44.0.0；签名、安装器和 OTA 不属于上述结果。

2026-10-05 补查：新增真实提问测试先复现了跳过返回码误报失败、多选被作为自由文本传入的问题，再完成修复。跳过只在问题 dismiss 路由且 `data.dismissed` 为真时接受上游 `40909`；其他错误仍失败。多选转换为原生选项 ID，可保留带逗号的选项标签、混合自定义文本及多个问题。新增非交互 CLI 测试确认保留问题并返回 `needs_input`，没有 `question_error`；五项提问测试加入结构 CI。修复后全仓回归、10 项集成重新通过。

## 信任上游，验证外壳

2026-10-05 用户明确：信任 Kimi CLI 的原生能力，重点是 Harness 外壳不能破坏它。按 [PD-048](product-decisions.md#pd-048信任-kimi-原生内核迁移验收聚焦外壳兼容)，远端摘要质量与长上下文检索效果不再列为迁移阻塞项。

新增 `pnpm test:compaction-compat`：本地受控模型在首轮返回较高上下文用量；Kimi Code 2.1.1 按自身默认行为自动压缩，服务返回固定摘要标记。Harness 必须映射原生开始/结束事件、保持同一会话身份、让后续模型请求包含该摘要标记，并在第三个独立 CLI 进程恢复后继续使用它。测试通过；没有改压缩阈值、算法或原生历史，也没有对摘要内容打分。该兼容检查已加入结构 CI。

现有 Scope 复用/更换、审批、问题、工具参数与结果、身份恢复、取消、并行隔离和异常清理测试继续作为外壳验收。具体远端模型连接和供应商协议仍可按运行环境验证，其能力质量由上游负责。

## 兼容性与未验收项

| 边界               | 当前行为与影响                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧聊天的模型记忆   | 消息和诊断仍可查看，旧 Python 上下文不能直接由新内核恢复。首次继续建立新段；重要背景需重新提供，工程状态仍由既有 Context Anchor 读取。                                                                    |
| 运行时与自定义脚本 | Harness 最低 Node.js 24（内核最低 22.19），固定 Code 2.1.1。旧 `KIMI_EXECUTABLE`、Wire 参数、直接调用 SDK 0.1.8 的脚本不兼容；Harness 入口已适配，新旧原生工具名称不能混用。Chip 的 Python 环境另行保留。 |
| 模型配置           | Harness 已存的 provider、端点、模型、密钥继续使用；`openai_legacy` 映射及输出上限已在受控服务验证。具体远端服务的连接与参数协议按运行环境确认，模型能力质量信任上游。                                     |
| MCP 启动           | 配置的任意 MCP 连接失败会阻止本轮启动，避免悄悄少工具。损坏或不可达的可选服务须修复或在资源设置禁用。                                                                                                     |
| 诊断数据           | 新事件增加 `kimi-code.event`，界面沿用映射的 `sdk.event`。快照是已保存对话，不能再按旧 context/wire 文件格式或完整模型请求解释；直接解析原生诊断文件的下游脚本需调整。                                    |
| 异常连接           | WebSocket 断连明确结束本轮，不透明续流，也不自动重复修改动作；下一轮只恢复已落盘材料，最后尚未持久化的片段不保证保留。                                                                                    |
| 待验收             | Windows/Linux 和 macOS Intel 新版打包、签名/OTA、新内核长时并发资源压测、真实 GUI/PCB/芯片计算与 signoff。旧内核的测试与压测不能替代这些项目。                                                            |

旧 27B 长上下文和自动压缩测评属于旧内核历史证据，可用于模型服务诊断；本次迁移以外壳兼容作为门槛。具体 GUI 供应商、Windows/Linux 打包与安装仍需独立验收。WebSocket 异常目前明确结束当前轮，不实现断连后的透明续流；已落盘上下文可在下一轮恢复。完整 Industrial Core Vertical Slice 的既有缺口不因本迁移完成。

## 对齐当前主分支

创建 PR 前对齐主分支 `94a39eb`，保留已合入的工程只读隔离、持久 Domain Runtime、项目指令/技能映射和无交互提问策略。隔离启动器通过当前 Node/Electron 执行随包 JS 入口；真实 Project 通过原生 workspace `add-dir` API 注册（`persist: false`），重开进程时重新注册，不写 Project 配置。`.kimi-code` 优先使用项目原生资源，缺失时映射旧 `.kimi` 技能/指令；Claude/Codex 项目技能作为额外根保留。CI 原生门禁、配对模型驱动和 Linux 安装器改用随包 Code 2.1.1。

对齐后的验证：全仓 245 项，243 通过、0 失败；2 项跳过分别为仅 Linux 适用的 Unix socket 隔离和未配置的可选 KLayout Viewer。12 项架构检查和配对模型驱动共 13 项通过。真实 RTL Core 与旧 mutation 拒绝 9 项通过，包括实际 Verilator、取消/恢复、审批与工程只读边界。项目技能、提问、压缩、资源和异常隔离集成通过；外部 MCP 在当前主分支的受保护会话中继续拒绝（不将旧直连回归当作当前工业授权）。

最终 macOS arm64 未签名 `.app` 重新打包后通过归档内隔离启动器验证：实际 Code 2.1.1、认证宿主 MCP 回调、2 次审批、原生问题跳过、Bash 写入 session workspace、Web 资源读取和进程重启后恢复。源码格式检查、Desktop TypeScript/Vite 构建及 frozen lockfile 安装通过。Linux 安装器完成脚本语法检查，完整安装与其原生隔离验收留给 Linux CI；签名、安装器与 OTA 未在本次本地运行。

PR CI 补查：通用打包门禁在 Linux x64/arm64、macOS arm64 和 Windows x64 上验证包外 Broker/Skill 入口、依赖闭包和真实随包内核的 `--version`。受保护的完整 Agent 对话放在 macOS 和 Linux x64 原生门禁中独立执行，并检查 `projectWritable: false`；测试不跳过，也不放宽生产隔离。Linux 安装消费验收改用新版原生 `Read`/`Bash`，继续验证技能按需读取、项目写入拒绝、Agent 无 Docker 权限、宿主环境检查与实际 RTL 验证。

原生 CI 另显式准备 `ripgrep`，避免原生 Grep 的首次网络下载影响验收；Linux bootstrap 与独立安装器同时声明该前置依赖。CAD 全屏导航验收在同一渲染任务中等待按钮可用再点击，以覆盖 fullscreen 事件早于 React 标签更新的时序；工程和显示断言保留。

CAD 旋转验收同样等待真实画布重绘：相机属性的 React 更新早于 native pose 的下一帧执行。截图在导航完成后取基线，只比较 CAD 画布，并有界等待旋转后的像素差异；继续要求真实重绘。本地 FreeCAD 1.1.4 加 Electron 验收通过，包括建模、边/面拾取、尺寸、剖切、旋转/平移/缩放/全屏、导出与坏文件拒绝。

## 对齐共享工程主线

PR 修复期间 `main` 合入 `a034295`（共享工程底座和宿主外部 MCP），再次 rebase 并保留该实现。新增原生/分包/安装门禁均使用各自随包 Code 2.1.1；共享工程从空目录经过创建、任务通过、修改变 stale、失败、修复与再次通过，沿用主线证据和历史保留断言。

宿主 Runtime 回调恢复原 SDK 的审批边界：只有认证的 Harness MCP 命名空间和本轮实际注册的 Runtime Tools 可以把传输层审批交给宿主；工具处理器继续检查 Scope/参数/快照，修改仍请求 Runtime 审批，拒绝会保存失败 Action。原生 Bash、不明回调和其他 MCP 服务仍走 Kimi 审批。新增回归检查不可信同名工具与原生 Bash 不能自动批准，并通过真实 CLI 的外部 MCP 拒绝/批准/图片/禁用测试。Linux 原生任务、安装升级、本地与 Docker RTL 已在前一主线 CI 通过；新主线资格以本次最终 CI 为准。

macOS 原生 CI 暴露了长工具调用时的连接中断：适配层遗漏 Server API 的应用层 `ping`/`pong`，原生服务会在约 20 秒未收到回应时关闭连接。修复只按原生协议回传相同 nonce，工具执行和空闲会话均回应心跳，不自动重放任务。新增真实 Code 回归先复现该错误，再检查 22 秒宿主回调、22 秒空闲后的续聊、同一原生身份和动作只执行一次；加入 macOS/Linux 原生门禁。

2026-10-07 外壳回归补充：多步文本/思考流在 step.started 重置字节偏移，同时保留原生序号去重和缺口检查；子 Agent 审批跨子 turn 转发且显示拥有者。受控模型驱动真实 coder 子任务验批准、拒绝、取消；问题转发仅验协议，coder Profile 的 AskUserQuestion 不作为已支持能力。宿主 Runtime 的审批预览与输入快照绑定，MCP 状态及取消按聊天隔离。
