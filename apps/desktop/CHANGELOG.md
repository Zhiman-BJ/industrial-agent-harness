# Changelog

桌面应用各版本的主要内容（由 release-please 依据 conventional commits 自动维护，可在 Release PR 中润色）。
每版的完整验证范围、发布条件与已知问题见 `doc/releases/<版本>.md`。

## [1.0.1-beta.7](https://github.com/Zhiman-BJ/industrial-agent-harness/compare/desktop-v1.0.1-beta.6...desktop-v1.0.1-beta.7) (2026-10-21)

### 本版内容

- **恢复在线领域目录**（#231）：领域目录与 `.hpack` 的签名、校验和发布独立于桌面安装包代码签名。未签名内测包仍不提供 Core 自动更新，领域包可以从签名的 beta 目录获取和更新。
- **远端聊天准备**（#230）：可以先建聊天，再由 Agent 提出文件及工具计划；授权绑定精确范围，同任务内自动同步已批准文件的新内容。新增文件、工具或任务仍需确认。
- **PCB 3D 元件模型**（#235）：读取板图实际引用的 STEP／支持的静态 WRL，保留前后面放置与变换；缺失官方 STEP 可按需下载至校验缓存。打开板图不会自动下载整个模型库，缺失／超限模型明确显示。同步固定的外部 Domain Packs `5cc78f4`，包含 PCB／FreeCAD 本地验证契约修复和官方模型目录。
- **本机 Agent 分层隔离**（#236、#238）：macOS 使用可启动的 Seatbelt，Linux 使用可启动的 bubblewrap；工程、会话和 scratch 可写，受保护目录及敏感凭据路径受限，封堵宿主 Unix socket 路径。隔离原语不可用时回退当前用户权限；Windows 当前仍无本机 OS 隔离。实际边界以会话报告为准，不能把审批或工作目录当成 OS 隔离。
- **验证与当前输入分开**（#239）：历史验证结论绑定记录的输入；工程被原生工具、IDE 或人工改动后，当前输入显示 changed／stale，不继续把旧检查当成当前工程通过。
- **界面与发布验收修正**：简化模型选择控件（#234）；修正 PCB 3D wheel 验收输入、受控模型对环境诊断的误判，以及打包冒烟中旧的 current-user 固定断言，保留真实拒绝、原缩放阈值和平台边界检查。

## [1.0.1-beta.6](https://github.com/Zhiman-BJ/industrial-agent-harness/compare/desktop-v1.0.1-beta.5...desktop-v1.0.1-beta.6) (2026-10-19)

### 本版内容

- **项目创建与领域包引导**（#210）：支持创建通用项目；未安装领域包时提供安装入口，已安装领域包可在项目创建时选择。
- **远程执行接入**（#200）：接入远程沙箱执行、CAD 结果文件展示和会话资源释放。
- **账号绑定与任务收尾**（#189）：远程请求获取令牌后再次校验账号绑定；界面展示异常时仍完成任务状态收尾。
- **桌面界面与开发启动修复**（#220、#217）：合入界面回归修复及模块化验收流程，修复 Windows 开发启动器对子进程的调用。

## [1.0.1-beta.5](https://github.com/Zhiman-BJ/industrial-agent-harness/compare/desktop-v1.0.1-beta.4...desktop-v1.0.1-beta.5) (2026-10-16)

### 本版内容

- **修复桌面端检测不到 Docker 的问题**（用户反馈：终端里 `docker` 命令正常，安装器却报 "Docker was not found"）。根因是新版 Docker Desktop（4.89+）默认把命令行工具装在 `~/.docker/bin`，只写进终端的配置文件；从 Finder/Dock 启动的桌面应用拿到的是系统给的最小 PATH，看不到这个目录。本版起查找 Docker 的顺序为：终端同款 PATH → 各平台常见安装位置（含 `~/.docker/bin`、`/usr/local/bin`、Docker.app 内置目录）→ 兜底读取登录终端的完整 PATH（限时 10 秒，失败自动降级）。安装域包、环境体检（doctor）和容器任务执行三处一并修复；找不到时报错会列出所有搜索过的位置，方便自助判断。
- **界面体验批次**：落地 10-10 体验走话的第一轮 12 项修复（#94，含消息流、审批与设置入口等）；回合结束状态改为中文显示，不再中英混排（#204）；修窄窗口下审批下拉被截断的问题（#206）。
- **输入框升级**：作曲区显示当前模型名称与会话上下文占用（#203）。
- **数据隔离**：打包后的正式应用改用产品级用户目录，不再与开发实例共享配置，避免互相污染导致项目列表或聊天记录异常（#205）。
- **运行时下载改造**：域包原生运行时改为引导式官方渠道下载，替代此前的托管拉取（#198）。

## [1.0.1-beta.4](https://github.com/Zhiman-BJ/industrial-agent-harness/compare/desktop-v1.0.1-beta.3...desktop-v1.0.1-beta.4) (2026-10-15)

### 本版内容

- **未签名 mac 包改为 ad-hoc 自签**：内测包此前完全无签名，浏览器下载后首次打开被 macOS 判为「已损坏，无法打开」且无系统设置放行入口。本版起未签名通道的 mac 安装包带 ad-hoc 签名，弹窗降级为常规「Apple 无法验证」警告，可通过 系统设置 → 隐私与安全性 → 仍要打开 放行（命令行 curl 下载仍完全无弹窗）。
- 内容与 1.0.1-beta.3 一致（发布流水线凭据阶梯/瘦身/发布令牌修复均为基础设施变更）。

## [1.0.1-beta.3](https://github.com/Zhiman-BJ/industrial-agent-harness/compare/desktop-v1.0.1-beta.2...desktop-v1.0.1-beta.3) (2026-10-15)

### 本版内容

- **发布流水线凭据阶梯**：`desktop-v*` 发布流水线在签名凭据（Apple Developer ID / Windows 证书）未配置时不再直接失败，而是自动降级为未签名内测构建——Release 标题与说明会明确标注 "unsigned internal build"，并跳过 Core 自动更新 feed（未签名安装包无法安全承接 OTA）。凭据配齐后同一条流水线无需改动即产出签名+公证版与更新 feed。
- 内容继承 1.0.1-beta.2（PCB bench 工具面、Freecad 路径容错、CI 恢复），基线为 main `344101c`。

## [1.0.1-beta.2](https://github.com/Zhiman-BJ/industrial-agent-harness/releases/tag/desktop-v1.0.1-beta.2) (2026-10-10)

### 本版内容

- **PCB bench 工具面**：PCB Domain Pack 与 PCB-bench 模型侧对齐——89 个 `pcb.bench.*` 原子工具（core/components/schematic/pcb/verification/delivery/operate 七个阶段 capability）、上游 `pcb-design-e2e` Skill 11 文件原版内置、101 个 actor 源文件随包分发（chip 式集成），执行走容器网关（Docker 镜像由包内 `Dockerfile.local-dev` 构建）。本地有界编辑 profile（`pcb.kicad.edit/verify`）保持不变，`pcb-kicad-native` Skill 独立提供。
- **Freecad 路径大小写容错**（domain-packs #13，issue #91 修复随 pin 一并进入）。
- **CI 恢复**：仓库转私有后修复 PR 变更分类（`pull-requests: read`）与 trusted 架构检查的 PR-ref 拉取（job token 化）；架构治理哈希同步重算。

## 1.0.0

### 本版内容

- macOS 与 Windows 桌面安装包构建流程；首次启动可多选 Domain，之后可补装和更新。Pack 使用签名目录、摘要校验与事务安装；Core 更新在会话空闲后应用。
- 新增 Godot 工程工具与 Viewer，以及 PCB 工程和制造文件 Viewer。Godot 原生动作经过持久 Action 日志；进程成功不会被当成工程验收。
- 新增 macOS AutoCAD 操作 Skill，作为独立 CAD Domain Pack 分发。
- 保留 Chip、PCB 与 Godot 的共享 Broker Scope、CLI 与 Desktop 资源策略。

### 验证范围与依赖

macOS Apple Silicon、macOS Intel 与 Windows x64 的未签名打包应用已在 CI 完成首次启动、Chip + PCB 首装及 Godot 后补装烟测；macOS 同时补装 CAD。正式发行还需要 Apple 签名与公证、Windows 签名及 Pack 发行密钥，并验收实际安装器。真实旧版到新版 OTA、工业 StateProvider 与完整工程验证闭环尚未完成。模型服务、Kimi CLI 和领域专业软件仍需按环境准备。
