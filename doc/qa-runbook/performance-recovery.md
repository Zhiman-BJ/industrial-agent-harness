# PF：性能、崩溃与恢复

本页把性能观察、崩溃发现、修复回归加入验收范围。先遵守[协议](protocol.md)，公共层仍执行 [T0–T6](tiers.md)；与[工作台/聊天](workbench-project-chat.md)、[Viewer/成果](viewers-results.md)、[诊断/打包](diagnostics-packaging.md)交叉取证。依据：[会话资源保护](../session-resource-guards.md)、[聊天持久化](../chat-persistence.md)、[维护优化](../repository-optimization.md)。

**当前没有统一的启动时延、帧耗时、RSS 或 CPU 产品阈值。** 采样完成、单测通过、没有当场崩溃，只能分别说明观察结果或功能判据通过，不能写“性能合格”。比较前需固定同一设备、OS、应用/Pack/模型身份、负载与冷暖状态，事先记录目标阈值/容许退化和来源；没有约定的项明确写“仅测量，性能判定未建立”。已有源码上限、取消期限、额度等契约仍是可判定的功能边界，不因缺少性能阈值而取消。

## 已有自动命令与准确覆盖

所有命令从仓库根运行、保存原始退出码与独立日志；先核对固定依赖身份。下列定向检查不能替代 portable/native 全 suite。

```sh
node --test apps/desktop/electron/agent-events.test.cjs apps/desktop/electron/chat-history.test.cjs apps/desktop/electron/message-content.test.cjs apps/desktop/electron/project-files.test.cjs apps/desktop/electron/workspace-files.test.cjs
node --test packages/agent-kimi/tests/diagnostic-reader.test.cjs packages/harness-core/tests/chat-store.test.cjs packages/harness-core/tests/session-resources.test.cjs apps/desktop/electron/session-manager.test.cjs apps/desktop/electron/project-runtimes.test.cjs packages/harness-application/tests/task-service.test.cjs
pnpm benchmark:maintenance
node scripts/benchmark-desktop-display.cjs
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test:ui
pnpm --filter @industrial-agent-harness/desktop test:parallel
```

- T1 中的事件/历史测试验证批处理、拼接、迟到/重复消息与终态协调；文件测试验证有界源码读取与项目边界；不测真实 Renderer 的帧耗时。
- `benchmark:maintenance` 在独立临时目录对 8 MiB 工具日志分页、200 个 capability 的策略解析、1000 个聊天文本 chunk 入库测五次中位耗时，输出 JSON。它有正确性断言，没有性能通过阈值，也不启动 Electron；不能代表大聊天 DOM、首启或 UI 滚动性能。
- `benchmark-desktop-display.cjs` 直接调用展示事件与历史合并函数，输出 JSON：工具事件 2k/4k/8k/16k 的整批与逐条批处理共八场景，subagent 状态更新、逐历史轮次晚到事件各 500/1k/2k/4k 共八场景，总计 16 场景。每场景预热一次，通常测五次、逐条批处理测三次，保留原始耗时与中位数；输入 fixture 构造和正确性断言不计时。断言校验输出内容/顺序、轮次状态及输入未被修改等正确性；**没有时延阈值 gate**。名称中的 IPC batch 只模拟函数收到的批次，不运行真实 IPC、Renderer/DOM、网络或自动恢复，不能据此宣称界面响应性能合格。
- chat-store 的 killed-process 用例覆盖持久层中断记录与过期审批，TaskService/session-manager/project-runtimes 覆盖关停与失败清理。它们不等于 Electron main 强杀后全应用恢复。
- T2 parallel 用受控 SDK 会话操作真实 Renderer/IPC，覆盖聊天/项目频繁切换、旧历史延迟、Renderer reload、后台审批与关闭；新增在会话完成后调用 `forcefullyCrashRenderer()`，确认 `render-process-gone` 和原 main 存活，崩溃期间仍能从主进程读取同一历史；再由**测试显式 reload**，检查历史/终态不重复、不复活旧审批或 Stop，恢复后可运行新任务。它验证该隔离场景的手动恢复路径，不证明产品自动检测并自愈，也不覆盖所有在途任务阶段；UI 布局断言不是帧率 benchmark。
- 不存在本页可直接调用的“全应用崩溃恢复”或“首个可用画面时延”测试脚本；下面这些项须手工采集并明确缺口。

### 打包版受保护本地探针

`node scripts/smoke-packaged-desktop.cjs` 在真实安装包的 Electron main 中，经共享 `TaskService.diagnose` 执行 `project.environment.inspect`，使用独立临时工程、配置和事实存储，关闭 Runtime 后清理。macOS 必须取得带 Action ID 的环境报告，且 `protected local execution` 为 `ready`、含 `HARNESS_PROTECTED_TASK_READY`；不能只看报告顶层 `ready`，因为空工程的本地探针属于可选检查，失败时顶层仍可能为真。该结果写入 `desktop-first-run.json`（`--domains` 模式为 `desktop-domain-install.json`）的 `packagedLocalExecution`。Windows 仍要求正确返回明确的本地任务不可用原因，不扩大平台资格。

同一 macOS smoke 还在临时工程声明固定的 Electron-as-Node 任务，经共享 Runtime 的审批、输入快照、执行、独立 checks-json Verifier 路径完成。必须保留 canonical Action、execution/check artifact 身份与 `passed` 验证；五项断言检查 Node 模式、选中输入可读、未选中项目文件拒读、外部测试文件拒读、输出目录可写。执行身份必须仅开放应用的 `Contents`，不能扩大为 `.app` 根或其父目录。测试不改写安装包文件；普通首页 ready、源码 Node 测试不能代替这条 Framework/Node 模式打包回归。

这两项检查用于覆盖 beta.7 的 DYLD/SIGABRT 启动崩溃及修复后的任务边界。macOS 验收同时保留应用版本/源码 SHA、可执行文件路径、报告及 stderr，确认没有新增对应子进程崩溃报告；若出现崩溃，按 PF-09 保留 OS 报告与父子 PID，分别判断主进程、Renderer 和探针。只读应用依赖的写保护等完整边界仍需独立执行 Runtime 测试。当前 Linux 环境不能证明 macOS 安装包已通过，须在目标平台实际运行命令后记录结果。

展示函数的旧版对照可指定源码目录，该目录必须同时包含 `agent-events.ts` 与 `chat-history.ts`（例如目标版本的 `apps/desktop/src`）；不传参数默认当前工作区这两份源码：

```sh
node scripts/benchmark-desktop-display.cjs /absolute/path/to/sourceDirectory
```

将 stdout 重定向到本次独立证据目录的 JSON，另存 stderr 与退出码；原始样本、实际 sourceDirectory、源 SHA/dirty、脚本版本和设备信息一起保留。新旧比较使用同一脚本、设备与负载；正确性断言失败时先记录 fail，不能用更短耗时抵消错误。该测量不是现有 CI 自动门禁，执行与否必须单列。

完成 T4 固定 Kimi、原生工具及真实 loopback 前置后，再执行：

```sh
pnpm test:chat-resume
pnpm test:session-resources
pnpm test:session-chaos
node --test tests/integration/background-tasks-kimi.test.cjs packages/agent-kimi/tests/process-sandbox.test.cjs
pnpm stress:sessions
```

这些集成使用本地受控模型，不评价生产模型速度。session-chaos 实际终止测试创建的 Kimi 子进程，检查另一会话不受影响及已落盘上下文恢复；它不杀 Electron main/renderer。process-sandbox 检查自身进程树的超时/取消清理；目标 OS 的 skip 必须按实际 suite 规则处理，不能把缺 Kimi 导致的 skip 记成通过。Linux sandbox 补充路径在 native-linux。

`stress:sessions` 仅支持 macOS/Linux 的 ps，要求固定 Kimi，估计可用内存至少 2.5 GiB；使用独立临时配置和本地受控模型，运行中内存不足会停止。它约每 150 ms 采样，输出各宿主/子进程的 RSS、CPU、数量与额度。受保护组与基线的 burst 大小不同，不能比较为相同负载吞吐提升；RSS 不是总内存，采样可能漏掉短峰值。脚本存在不表示当前 workflow 执行该压力测试。

## 手工场景与指标采集

先创建专用项目/profile/Pack store，保存初始文件与数据库清单、已落盘 chat/request/Action 身份；使用自建无敏感内容的大文件和聊天，不从真实用户配置复制。记录设备 RAM/逻辑核、OS、电源模式、应用源码/打包身份、缓存/网络状态、负载规模与测量工具。冷启动与重复启动分别报告，每项记录样本数、原始值、中位/范围；样本少时不把分位数作为稳定结论。

| ID                       | 操作与可观察判据                                                                                                                              | 采集指标／证据                                                                                            | 失败、恢复与缺口                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PF-01 首个可用画面       | 在独立 profile 启动源码或明确包身份的应用；分别记录进程开始、首画面、可聚焦输入/打开设置并响应的时点；关闭后重复，首次安装流程另列            | 时间戳或屏幕录像逐帧、冷暖/是否 onboarding、启动至首画面/首个可用操作耗时、主/渲染进程 RSS                | DOM ready 或 loading 画面不算可用；卡住/崩溃保留启动 stderr/OS 诊断，再从同一专用 profile 重开。无性能阈值则只报告数值                                                             |
| PF-02 大聊天与事件流     | 固定聊天数量、轮数、字符/工具输出字节、chunk 数及速率；加载历史、持续流式输出时输入草稿/滚动/切聊天；核对无丢失/重复/跨轮串入                 | Chromium DevTools Performance 录制、长任务与交互耗时、DOM 数量、JS heap/进程 RSS、完整文本 hash、响应次数 | 计时区分模型等待与 Renderer 处理；数据正确也可能卡顿。现有 1000-chunk 入库测量不覆盖这条完整 UI 路径                                                                               |
| PF-03 大文件与日志       | 用无敏感 fixture 打开超 2 MiB 源文件、超目录上限的树、大工具 JSONL 和超限 Viewer 文件；分页/切文件后返回                                      | 文件大小/树规模、实际返回 bytes、truncated/超限提示、耗时、RSS/heap 峰值、读取前后 hash                   | 源码预览现有 2 MiB 上限，树现有最多 250 项且受深度约束；专业 Viewer 各用自身限制。不得将截断或拒绝超限误判崩溃，也不能将无限完整读当成正确                                         |
| PF-04 布局循环           | 固定次数循环两列/标签、侧栏/文件树开合、640×480/常规尺寸、Viewer 全屏及 Esc；保留打开文件、缩放/草稿与后台任务                                | 每轮耗时、console 错误/未处理 rejection、挂载/会话数、前后截图、文件/标签/焦点身份                        | 不抢焦点、不丢状态、无残留错误。布局正确不代表无卡顿；失败记录触发顺序，重新加载后复验同一序列                                                                                     |
| PF-05 资源循环           | 固定轮次创建→运行→完成/取消→关闭聊天，另测多项目与空闲回收；前后按 PID 采样 main/renderer/Kimi/MCP/领域子进程                                 | 轮次、峰值/空闲稳定 RSS、CPU、进程/资源槽数、idle TTL 后剩余、heap snapshot（仅专用数据）                 | 区分允许的常驻缓存与逐轮增长；采样增长是调查线索，不能直接命名内存泄漏。不得关闭内存保护来伪造通过                                                                                 |
| PF-06 正常退出无孤儿     | 在运行、待审批、后台任务、领域准备中分别经正常 Quit；记录退出前测试进程树与角色，等待退出后再次核对同一批 PID/子代及文件句柄                  | Quit 至终止耗时、存活 PID/PPID/命令角色、资源/安装 journal、退出码                                        | main 消失不证明子进程已清理；不能按名称批量 kill 其他会话。残留先取证，只对确认属于本次隔离测试的进程处理；正常窗口关闭与 macOS Quit 分开记录                                      |
| PF-07 Renderer 异常      | 专用 profile 下分别验普通 reload、Renderer 强制崩溃后显式 reload；核对历史/终态没有重复、恢复后新任务可运行，并观察 main、后台任务与草稿/审批 | 普通 reload 与 crash 分开记、OS/console 诊断、当前 chat/request、后台 PID、恢复动作与新任务结果           | parallel 已包含真实 crash→测试显式 reload 的受控路径；手工扩大到实际目标包/平台和不同任务阶段。当前未确认自动 crash reload 契约，不预设会自愈；普通 reload 结果不能代替 crash 结果 |
| PF-08 main 异常及重启    | 专用工程先完成一轮并保存身份/文件 hash，再在受控执行或等待交互时异常终止已确认的测试 main PID；重启同一 profile，读取历史与成果并继续         | crash 时间、退出/OS 报告、已完成与在途 request/chat/Action 身份、文件与逻辑记录前后、重复执行计数         | 不承诺强杀时最后未落盘片段；已落盘记录保留，在途如实 interrupted/unknown，失效审批不复活，不自动重放修改。main 崩溃可能绕过关停，残留需按 PF-06 单独调查                           |
| PF-09 取消/超时/子进程死 | 对本地受控任务试立即 Stop、等待额度时 Stop、审批/后台期间 Stop、重复 Stop、CLI timeout；只强杀本次 Kimi 或工具子进程，再继续原聊天            | 目标 chat/request/PID、取消至终态耗时、工具树/额度释放、另一聊天仍运行、已落盘 native 身份                | 取消不等于工程通过；不得把客户端超时假定远端未执行。挂起/未知结果保留身份再查询，不自动重发；参考 RE 的未知提交规则                                                                |

### PCB 模型获取与组装观察

本轮官方模型按需下载和实体渲染尚待当前版本的真实桌面/GPU验收。按 [VR-08–VR-11](viewers-results.md) 分开记录冷下载、暖缓存、离线缓存、STEP/本地 WRL 解析及 GPU 首画面：所需/实际条目数、网络字节、命中缓存数、取消至终态耗时、每模型与总解析时长、已加载/不可用/省略实例数、三角形与 geometry bytes、heartbeat、Browser/Tab/GPU 工作集。记录同一源板/库 revision/hash、设备及采样方法，不能把网络等待算作 GPU 构建，或把整个库的 inventory 当作测试负载。原始 8/64 MiB、解析时限和总三角形预算是功能边界；仍没有额外统一性能合格阈值。单次成功、CPU 对账或小 fixture 不能代替复杂板、取消/跨项目和图形上下文故障的实际证据。

## 故障注入边界与问题闭环

1. 注入前写清目标角色、专用 PID、触发点、预期错误和回收方法；一次只注入一个故障，再用同一 fixture 跑未注入对照。权限/运行环境不允许的注入标 blocked，保留已有功能回归结果。
2. 不对真实用户配置、私人聊天、真实账号刷新、线上远程作业或共享 Docker 服务做强杀、磁盘填满、全机 OOM、断网、损坏文件测试。磁盘/文件错误只限测试目录与测试文件；网络错误只限本地受控服务；真实软件安装故障用独立 store，不破坏用户已安装软件。
3. main/renderer 崩溃、Kimi 死亡、工具子进程死亡、网络断开和窗口 reload 分别记录，不能互相替代。观察到 crash 时保留 OS 报告、stderr、时间线、版本、触发序列和脱敏证据；没有 crash 也不等于覆盖了该故障。
4. 所有本轮发现进入**主报告指定的同一个汇总 issue**，按 PF/WB 等稳定 ID 分项；不要为每个现象另建 issue。每项保留严重程度、最小复现、实际/预期、性能原始数据、影响版本/平台、证据、归因可信度、修复提交及回归结果。重复现象关联原项，不覆盖原失败证据。
5. 修复后先跑能复现的最小测试/同负载场景，再按所属层回归；性能问题需用原设备/数据/冷暖条件复测，单次变快不能关闭。关闭条件必须包含原错误消失、失败恢复正确及没有相关功能回归；阈值仍未约定的性能项保持“已测量/待判定”，不冒充合格。

## 自动覆盖缺口

当前自动覆盖包括流事件/持久层正确性、有界读取、Renderer reload、真实 Renderer 强制崩溃后测试显式 reload 恢复、共享资源额度、受控 Kimi 死亡和生命周期。仍没有产品自动 crash 自愈证明、Electron main 强杀后的全应用恢复 gate、统一首启/交互时延 gate、持续 UI 内存泄漏 gate 或全平台无孤儿进程证明。手工矩阵用于补齐这些证据，不把受控场景扩大为全部任务阶段或平台。平台、打包模式和性能阈值各自记录；受控模型集成与历史压力数据不能替代当前版本/生产负载的性能结论。

[返回矩阵](modules.md)
