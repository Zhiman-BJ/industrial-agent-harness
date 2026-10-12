# 全新桌面安装体验 QA，2026-10-12

## 测试对象与隔离

测试锚点为 Harness `56c13604ca9956a57aa3585c4f920bb7e3409b21`，消费
Domain Packs `e7347c14bddc956ed0336570dea0af652ccec296`。从该源码重新构建
renderer、stage 和 ARM64 DMG，经实际 `hdiutil` 校验挂载与 `ditto` 复制后，
正常启动复制出的应用；没有把 staged Electron 入口当作 DMG 验收。
应用保留正常 `app.asar` 依赖加载，不使用安装 fixture 或 readiness mock。

本地 DMG 为 `Industrial Agent Harness-1.0.1-beta.2-arm64.dmg`，
273,901,380 bytes，SHA-256
`c7fe17747f8b965869eeb940ff1cfde3cca68447209952b6172225bebeb3a414`。
构建环境没有 Developer ID 签名身份，因此本记录不代表已签名、公证或公开发布。

原始证据根为 `dist/qa-first-install-20261012/desktop/`。启动前 Pack store、
用户 profile、HOME 和全局配置均为空且独立于实际用户目录。正常应用使用
`--user-data-dir` 和隔离环境变量启动，未传 selftest 标志。未提供
`HARNESS_RUNTIME_ARCHIVES`、已安装应用、工具路径覆盖或成功 receipt。
`payload.json`、`launch-context.json`、`git-status.txt` 与 `anchor-sha.txt`
保存构建、隔离和基线身份。

## 首次界面检查

首启自动打开领域选择，五个领域全部可勾选，没有把 CUDA 隐藏或标为不可安装。
未配置在线目录时，明确提示可安装内置领域。实际界面显示：

| 领域              | 界面声明的安装与前提                                                               | 本次范围             |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------- |
| Chip 0.7.0        | 下载约 1.2 GiB；Docker、Harbor 托管 EDA，无宿主 Python；物理设计需工程自有 PDK     | 首屏可选及说明检查   |
| PCB 0.3.0         | 下载约 2.5 GiB；Harbor KiCad 与设计容器，需要 Docker                               | 首屏可选及说明检查   |
| Godot 0.2.3       | 下载 162.7 MiB；Harbor Godot 4.7.2，结构工作流不需 export templates                | 真实冷安装与后续任务 |
| CAD 1.1.4-pack.10 | 下载约 692 MiB；Harbor FreeCAD 与 DXF 容器，需要 Docker，AutoCAD 可选              | 首屏可选及说明检查   |
| CUDA 0.2.0        | 配对认证 Compiler/Evaluator 服务及不可变工程绑定；管理员准备访问凭据，本机无需 GPU | 首屏可选及说明检查   |

CUDA 的“下载 0 B”来自客户端 bundle 没有本地托管 runtime assets；它不表示
远端 private Harbor worker 镜像没有体积或无需管理员部署。

选择 Godot 后，界面显示下载 162.7 MiB、安装后约 337.6 MiB、需要
564.3 MiB 空闲空间，以及本机实际可用空间。实际下载于
`2026-10-12T05:08:26.653Z` 开始；首轮进度有已下载字节、速度、预计剩余时间
和取消按钮。与另两项独立 Harbor 冷下载短时并行，速度不是单连接独占基准。

## 体验问题

- **本地化不完整**：中文外壳下 Chip、PCB、CAD 的 summary 和多数领域的
  prerequisites 仍为英文，Godot summary 又已翻译。Docker、PDK、远程服务等
  决定可用性的关键信息也在混合语言中；功能可安装不消除这个理解成本。
- **CUDA 下载体积语义有歧义**：“0 B”没有就地明确限定为客户端本地工具下载，
  用户容易误以为远端服务无部署成本。旁边虽声明管理员服务前提，仍宜明确解释。

## 首任务与恢复方法

专属 `scripts/qa-fresh-desktop-model.cjs` 仅提供 localhost 的受控模型响应，
安排真实 Kimi 发起 canonical Godot verify/edit/verify 调用。它不安装 Pack、
写就绪状态、直接运行 Godot 或生成通过结果。模型请求摘要写入独立证据目录；
真实 UI 的模型配置、工程创建、消息提交和审批通过 Computer Use 操作。
这是执行链与界面 QA，不是语言模型推理能力评估。

复用 helper 时传入普通结构工程目录与一个**尚不存在的新证据子目录**；其父目录须已存在。
`node scripts/qa-fresh-desktop-model.cjs PROJECT NEW_EVIDENCE_DIRECTORY` 会原子创建目录，
遇到已有目录即拒绝，不能覆盖历史请求。早期 wrong-tool 请求已单独保留；此护栏为收尾改进，
没有因此重做或替换本轮 UI 证据。

工程输入是从锁定 Owner 复制的普通 `examples/structural` 文件，未复制安装状态或
工程证据。CUDA 使用同一 Owner 的 `examples/square`。本次不覆盖从空目录创作工程。

## 实际安装与工程结果

**本轮桌面端到端验收失败。** Godot 冷安装完成，但首个真实工程验证被严格拒绝；
此外正常退出没有完成。安装成功、诚实显示失败和持久化恢复分别记录，不合并为工程通过。

| 环节                  | 结果      | 实际观察                                                           |
| --------------------- | --------- | ------------------------------------------------------------------ |
| DMG 首次启动          | PASS      | 实际挂载复制后的 `app.asar` 正常运行，五领域可选                   |
| Godot 无缓存安装      | PASS      | Harbor 下载、SHA 校验、解压、签名及版本检查、激活完成              |
| 首工程审批与执行      | FAIL      | 实际 `godot.scene.verify` 获批并执行；返回 `insufficient_evidence` |
| Godot 编辑与再次验证  | NOT RUN   | 首次验证失败后停止，没有用后续操作覆盖失败                         |
| CUDA 客户端安装与加载 | 限定 PASS | 正常 `app.asar` 解析 SDK 与 StateProvider；明确外部服务未配置      |
| 正常退出              | FAIL      | Cmd+Q 与重启后显式应用菜单 Quit 均关窗，但主进程仍存活             |
| 终止后重启恢复        | PASS      | 同 profile 恢复两工程、历史、审批、失败证据及领域安装状态          |

Godot 安装 journal 的窗口为 `2026-10-12T05:08:26.772Z` 至
`2026-10-12T05:21:15.182Z`，共 768.410 秒。缓存中实际 ZIP 为
170,622,178 bytes，SHA-256
`c58a24e31d720be9d62f60cb5627c4e695fb72f21b0cfe1bc9ccaa9a3b3ba63e`；
生产 receipt 的 `checkedAt` 为 `05:21:14.919Z`，已安装可执行文件 SHA-256 为
`c7cccbf8fb143e34e02fd6521e09be2c2b974f0d5db080b19071c9c570718ccf`。
完整 receipt 位于原始证据的 `packs/.runtime-assets/godot/4.7.2-<archive SHA>/receipt.json`。
该窗口与另两项独立 Harbor 下载重叠；没有单独测量 body 下载结束时间，
不能把 768.410 秒解释为纯网络传输耗时或独占网络表现。

首个实际 Action 为 `9fa33071-9b4e-4394-a6b3-cc44fee035c1`，Run 为
`97f002df-7283-4e14-bb94-f85758703154`，trace 为
`937901e3-921a-44ef-a63e-e40e97cb6f86`。Godot import 于
`05:24:39.086Z` 至 `05:24:41.725Z` 执行，退出 0，但日志两次报告用户已注册字体
`NotoSansCJKsc-Regular.otf` 无法读取，Verifier 正确拒绝通过。
UI 显示“工程证据不足”“部分成果 · 部分操作失败”，并提供 `inputs.json`、
`import.json`、`import.log` 和本次输入文件链接。

独立对照已确认这是生产 macOS sandbox 未声明用户字体只读访问的缺口，
不是仅由本次隔离 HOME 引起。系统 CA 初始化诊断仍在，但现有 Owner 已精确过滤，
不是此次阻断原因。详见[字体边界诊断](qa-fresh-install-prerequisites-20261012.md#独立诊断godot-导入与-macos-字体沙箱边界)。
没有修改 sandbox 或放宽验证，也没有把诊断中的 import 通过算作本次首工程通过。

CUDA 安装 journal 为 `05:26:42.344Z` 至 `05:26:42.415Z`；客户端无需下载本地
native asset。能力中心显示“外部工具尚需配置”，普通 CUDA 工程实际解析为
`cuda / kernel`，载入 StateProvider 并生成 7 项输入 hash。没有 SDK 模块解析错误。
这证明当前 packaged Electron 的加载路径，不证明远端 Compiler/Evaluator 可用或 GPU 工程通过。

CUDA 早期受控模型误把日期提醒当作当前任务，选择了 Godot 工具；生产 scope 正确拒绝。
该失败保留于 `model/cuda-fixture-wrong-tool-requests.json` 与 trace
`eb3007ee-62e3-4a30-9c87-1b13c6b01dc4`，不作为 SDK 或远端服务故障。
QA helper 已修正为查找实际带 QA 标记的用户请求，但未重跑更多 CUDA 工具。

## 退出、恢复与清理

解锁后实际执行 Cmd+Q，窗口消失，但原进程 `43138` 超过两分钟仍存在。
生产 `before-quit` 会等待领域操作、TaskService 与 GUI bridge 清理；本轮未定位具体等待点，
不据此断言死锁根因。为完成恢复检查，保存 `quit-observation.json` 后仅对该自建进程
发送 SIGTERM，再以相同应用、HOME、配置、Pack store 和 userData 重新启动进程 `50691`。

重启 UI 恢复了两工程及 Godot 的已批准工具、原 trace、失败状态和全部证据链接。
能力中心仍显示 Godot“可使用”、CUDA“外部工具尚需配置”。模型配置保留，
本次会话密钥没有持久化，UI 提示重新配置；测试只使用 localhost synthetic key，未输入真实密钥。
再次使用应用菜单 `Quit @industrial-agent-harness/desktop`，窗口消失但进程仍存在，
因此正常退出未通过，列为独立 **P2 未修复问题**；持久化恢复仅限定为 SIGTERM 后恢复。详见
`restart-context.json`、`restart-observation.json` 及两个 `*-ax.txt`。

结束时仅终止自己启动的第二个应用进程及 QA 模型服务；`cleanup.json` 于
`2026-10-12T05:40:22.915Z` 确认三个自建 PID 均不存在、没有所属应用子进程残留。
没有停止 Docker、删除用户镜像、关闭其他应用或改动用户工程。

## 长期留存证据与范围

关键界面为[首次领域选择](qa-evidence/first-install-20261012/first-launch.png)、
[Godot 就绪](qa-evidence/first-install-20261012/godot-ready-card.png)、
[实际审批](qa-evidence/first-install-20261012/godot-approval.png)、
[首任务失败](qa-evidence/first-install-20261012/godot-first-task-failed.png)。
重启截图也已留存：[历史恢复](qa-evidence/first-install-20261012/restart-history.png)、
[领域状态恢复](qa-evidence/first-install-20261012/restart-domain-status.png)。
其余大归档、日志、数据库和完整应用保留于 `dist`，不纳入 Git。

此轮只在本机 macOS ARM64 做真实冷 Godot 安装；Chip、PCB、CAD 检查首次说明与可选状态，
没有重复其完整桌面安装。CUDA 未配置服务、未执行 GPU。没有验证签名公证发布、
空白工程生成、外部真实模型、其他平台或其他用户字体组合。专属 helper 的
`node --check`、Prettier 与 ESLint 均通过；这些静态检查不替代上述原生结果。
