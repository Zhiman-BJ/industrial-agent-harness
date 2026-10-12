# Headless CLI

CLI 不启动 Electron，也不导入桌面 UI。它面向真实工程任务与自动化场景：每次运行绑定一个项目目录和一个 Domain，使用与桌面端相同的 Broker、Kimi Integration 和 Capability Registry，并逐行输出 JSON 事件。

首轮回答结束后，CLI 继续等待 Kimi 原生后台命令、子任务和自动后续回答；最终 `result` 在后台处理及清理结束后输出。`--timeout-ms` 覆盖整个运行，后台提问仍输出 `needs_input` 并以 2 退出。等待、超时和通知由原生工具负责，外壳不生成额外 prompt。验收范围见[后台兼容记录](../../doc/kimi-background-compatibility.md)。

当前源码消费固定的 Domain Packs 0.6.0，共享受保护的领域 Runtime。真实 Agent 执行支持 macOS Apple Silicon（arm64）与使用 bubblewrap 的 Linux x86-64；专业工具的平台资格按 Pack 分别声明。托管 Chip 已在两者搭配 Docker 验收；CAD、PCB、Godot 和 CUDA 远程客户端目前限已验收的 Mac ARM64 profile。Intel Mac 暂不支持，Computer Use 组合仍需接入工业边界。`--scope-only` 保持无原生依赖的注册预览；真实运行重新读取工程状态。`result.engineering` 和 `industrial_result` 给出工程验证，`result.status` 表示 Agent 回合结束。详见[三轨整改记录](../../doc/harness-quality-three-tracks.md)。

## Linux Chip 一键安装

```bash
wget -O install-chip-linux.sh https://github.com/Zhiman-BJ/industrial-agent-harness/releases/download/chip-linux-installer-v0.1.0-preview.4/install-chip-linux.sh && bash install-chip-linux.sh
```

该历史 Release 安装运行时、Chip CLI/MCP 和 EDA 镜像；需要允许 bubblewrap 的用户命名空间。版本、路径、校验、模型配置前提及已知限制见[版本说明](../../releases/chip-linux-installer-v0.1.0-preview.4.md)。

## GitHub Release 安装

打开 [GitHub Releases](https://github.com/Zhiman-BJ/industrial-agent-harness/releases)，下载最新 `headless-v*` 预发布版本中的 `industrial-agent-harness-headless-<tag>.tar.gz` 和同名 `.sha256` 文件。当前源码接入的 SQLite 观察状态需要 Node.js 24 或更新版本；使用下载包无需克隆仓库或安装 pnpm。

```bash
sha256sum -c industrial-agent-harness-headless-<tag>.tar.gz.sha256
tar -xzf industrial-agent-harness-headless-<tag>.tar.gz
node headless/industrial-harness.cjs run \
  --project-dir /path/to/project --domain chip \
  --task 'Inspect netlist signals' --scope-only
```

macOS 可用 `shasum -a 256 -c` 代替 `sha256sum -c`。解压后整个 `headless/` 目录可移动，运行时不依赖原仓库。当前源码构建的包内含 Kimi Code 2.1.1，实际 Agent 需模型 API key；`KIMI_EXECUTABLE` 是可选的同版本覆盖。历史 Release 按随包说明使用旧 CLI。当前构建随附领域源码与托管依赖声明，工业应用和工具镜像通过 Pack 安装另行从 Harbor 获取。发布工作流在 Linux 上解压并烟测；其他系统尚无 Release 包测试承诺。

## 开发与场景 Suite

从源码可生成同样的无 UI 目录（打包机需要 pnpm）：

```bash
node scripts/package-headless.cjs
node dist/headless/industrial-harness.cjs bench --suite examples/bench/scope-smoke.json --output-dir /tmp/industrial-bench-results
```

`bench` 读取 JSON suite，顺序运行多个 `run` 场景，逐场保存 JSONL，并生成 `summary.json`；断言失败时返回非零退出码。Suite 中 `projectDir` 和可选的 `artifactManifest` 相对于 suite 文件定位。每个场景可设置 `scopeOnly`、`disabledSkills`、`disabledMcpServers`、`timeoutMs`，并在 `expected` 中断言 `status`、`capabilityIds`、`skills`、`tools`、`mcpServers`。请使用全新的输出目录，避免覆盖先前证据。`examples/bench/scope-smoke.json` 是当前披露基线，RTL 请求解析为 `chip.eda.managed` 的 canonical Runtime 工具；scope 检查不运行仿真，也不建立工程通过结论。

打包目录包含 CLI、Broker、固定 Domain Packs 的 Skill 文件、MCP 注册表、随包 Kimi Code 2.1.1、Server API 接入与只读观察状态存储；不包含 Electron 或工业可执行文件。当前源码消费固定的 Domain Packs 0.6.0：已安装领域通过托管 Runtime 调用，原生应用与预构建工具镜像由 Pack Manager 从自有 Harbor 准备。容器工具需要已运行的 Docker，用户无需自行配置 Python 工具环境。CUDA 需要管理员提供认证的远程 GPU 服务及项目绑定。真实 Agent 场景还需模型 API Key，`KIMI_EXECUTABLE` 为可选的同版本覆盖。历史 2026-10-03 源码修复的维护者重建要求见[运行时修复说明](https://github.com/Zhiman-BJ/industrial-domain-packs/blob/cf72a46b6b4ba927b091ded71b2d52d227db0351/packs/chip/eda-harness/docs/runtime-reliability.md)；当前安装态用户使用发布的不可变镜像，无需本地构建。已有 GitHub Release 不会随本地源码修改而更新。

历史独立 [Chip Pack 0.6.1 Release](https://github.com/Zhiman-BJ/industrial-agent-harness/releases/tag/chip-v0.6.1-preview.1) 保留 standalone MCP 安装路径与当时的网关验收记录，见[历史 Chip Pack 文档](https://github.com/Zhiman-BJ/industrial-domain-packs/blob/cf72a46b6b4ba927b091ded71b2d52d227db0351/packs/chip/README.md)。它不是当前默认 `chip-pack.runtime` 的安装前提。

每个 `headless-v*` Release 正文都列出该版**相比原生 Kimi Code 实际集成的 Harness 能力**及尚未集成的部分；发布时使用仓库中与标签同名的 `releases/<tag>.md`，不复用上一版说明。

`examples/bench/rtl-verification-target.json` 保留早期 `chip.rtl.simulate` 能力 ID 的历史目标断言；当前注册使用 `chip.eda.managed` 与 `chip.rtl.verify` 等工具。旧目标文件不作为当前原生资格或已通过的 CI gate。

```bash
pnpm cli run --project-dir ./examples/chip-sobel --domain chip --task 'Inspect the netlist signals' --scope-only
```

`--scope-only` 只输出能力 Scope 和披露 Trace，无须模型密钥。运行 Agent 时配置模型 API 密钥，默认使用随包 Kimi；仅需覆盖时才设置同版本 `KIMI_EXECUTABLE`。

模型 API 端点默认要求 HTTPS（localhost 除外）。自托管明文 HTTP 端点需在 `HARNESS_TRUSTED_PLAINTEXT_HOSTS` 中显式声明，逗号分隔，条目为 `host` 或 `host:port`（host 与 port 都匹配、只有 host 匹配时任意端口有效），例如 `HARNESS_TRUSTED_PLAINTEXT_HOSTS=192.168.1.50:48000`。桌面端与 CLI 共用同一校验。

## Computer Use 插件（`--enable-gui`）

`--enable-gui` 启用横切的 computer-use 插件：让 Kimi 在授权下操作桌面 GUI 应用。首次启用时自动从 [munim-computer-use](https://github.com/munimtechnologies/munim-computer-use) 的钉定 release（`v0.4.3`，见 `packages/computer-use-bridge`）下载对应平台二进制，校验 `SHA256SUMS.txt` 后安装到 `~/.industrial-agent-harness/gui-bridge/`（`GUI_BRIDGE_DIR` 可覆盖），已装则跳过；安装过程以 `gui_install` 事件输出（checking/downloading/verified/ready/error）。安装失败会使本次运行报错退出，不写入任何半成品。启用即授权：GUI 工具审批由 Harness 自动以 `approve_for_session` 应答，`--approval` 策略只作用于非插件工具。

已注册工业 Runtime 的实际运行暂不加载外部 MCP 或应用控制；`--enable-gui` 输出不可用原因且不安装/启动插件，本轮继续使用已注册 Runtime 工具。外部 MCP 在 Broker Scope 和 Agent 配置前排除，保存的资源配置保持原值。

- macOS 首次使用需在 系统设置 → 隐私与安全性 → 辅助功能/屏幕录制 中为**运行 CLI 的终端应用**授权一次（也可在终端运行 `~/.industrial-agent-harness/gui-bridge/munim-computer-use request-permissions` 触发系统弹窗）。
- `GUI_BRIDGE_BIN=/path/to/munim-computer-use` 跳过自动安装直接使用既有二进制；`GUI_BRIDGE_SOURCE_REPO` / `GUI_BRIDGE_TAG` / `GUI_BRIDGE_RELEASE_BASE` 可整体替换安装源（例如 fork 后发布自己的 release）。
- 插件不进 Domain 体系、不依赖当前项目；关闭方式即不加该旗标。

可重复传入 `--disable-skill chip.netlist.inspect` 或 `--disable-mcp SERVER_ID`，在该次运行中应用与 Project 详情页相同的资源策略。未知资源 ID 会报错。当前 Chip provider 为 `chip-pack.runtime`，其 canonical 工具由 Runtime/Broker 管理；没有默认 `chip-pack.eda` MCP 服务。`--disable-mcp` 仅作用于实际注册的 MCP 服务。

```bash
KIMI_API_KEY=... KIMI_EXECUTABLE=/path/to/kimi pnpm cli run \
  --project-dir ./examples/chip-sobel --domain chip \
  --task-file ./task.txt --model kimi-k2-thinking-turbo \
  --approval reject --timeout-ms 600000
```

输出为 JSON Lines，每条含 `schemaVersion` 和 `runId`。首条 `scope` 带 Broker Scope、匹配能力及 L0–L3 披露 Trace；后续为 `agent_event`、按需 `disclosure` 和最终 `result`。`--approval` 可选 `reject`、`approve`、`approve_for_session`、`auto`，默认拒绝；`auto` 启用原生 Kimi 自动审批。无交互输入的 CLI 遇到 `AskUserQuestion` 时保存问题，输出 `needs_input` 与最终 `result.status=needs_input`，停止本轮并以退出码 2 返回。使用同一 `--chat-id` 另起一轮提供明确说明；CLI 不代替用户跳过问题。密钥只从环境变量读取，不作为命令行参数传入。

可用 `--artifact-manifest FILE` 提供 Viewer 之外的工件元数据。文件为 `{id, kind, path}` 对象数组，路径必须位于项目目录内；CLI 记录内容哈希，并在工具调用时重新核验。CLI 的读取不代表工程验证通过。

每次 Agent 运行会发出 `diagnostic-log` 事件，指向完整 JSONL 诊断日志。日志包括 Broker Trace、实际提示词、SDK 暴露的原始事件、完整工具返回、压缩事件、审批和上下文统计；界面展示的长结果仍会缩短。默认日志位于 `~/.industrial-agent-harness/logs/`，观察状态数据库位于 `~/.industrial-agent-harness/state/`，可用 `--log-dir`、`--state-dir` 或同名 `INDUSTRIAL_HARNESS_LOG_DIR`、`INDUSTRIAL_HARNESS_STATE_DIR` 环境变量覆盖。日志文件权限为 `0600`，目录为 `0700`，已知模型 API Key 会脱敏；日志仍可能包含用户任务、思考内容和工具读取的工程数据，应按项目资料管理。`bench` 将两者放在输出目录下。

用 `node industrial-harness.cjs inspect-log --file /path/to/trace.jsonl` 可检查事件序号是否完整，并查看模型、Scope、工具调用与完整返回字节数、上下文占用和压缩次数；原始 JSONL 保留全部 SDK 可见内容。

每轮还保存固定 Kimi CLI 的 `context.jsonl` 和 `wire.jsonl` 快照，日志中记录路径、大小与哈希；可据此检查压缩后的实际会话内容。快照失败会显式记入诊断日志。

只读观察工具保存工件路径、SHA-256 和最小 Checkpoint，后续读取重新核验；观察本身保留 `not_run`。专业动作通过共享 Domain Runtime 记录完整 DomainState、Run、Action、Artifact、Verification 与 Checkpoint。`industrial_context_read` 可分页读取已有上下文；读取历史不产生新的工程验收。

CLI 与 Desktop 共用 `~/.industrial-agent-harness/resource-settings.json` 的全局 Skill/MCP 默认值及按真实项目目录绑定的覆盖；可用 `INDUSTRIAL_HARNESS_CONFIG_DIR` 隔离配置目录。项目显式启用或禁用优先于全局，未配置则继承。`--disable-skill` / `--disable-mcp` 最后应用，可为本次运行进一步禁用资源。Bench 要固定基线时请指定独立配置目录。配置损坏会明确报错，不会自动覆盖。

## 持久聊天

真实 Agent run 默认保留聊天，在 `chat` 与 `result` JSONL 中输出 `chatId`。`chats --project-dir DIR --domain DOMAIN` 列出同一项目的聊天，`run ... --chat-id UUID` 继续最近的兼容 Kimi 会话段。Desktop/CLI 默认共用 `~/.industrial-agent-harness/chats`；`--chat-dir` 或 `INDUSTRIAL_HARNESS_CHAT_DIR` 可隔离存储。`--scope-only` 不创建聊天。模型、Scope 或 MCP 策略变化时建立新段并保留展示历史；历史读取不会执行工具。详见 [聊天持久化](../../doc/chat-persistence.md)。

## 外部 MCP

`node industrial-harness.cjs mcp add --file mcp.json` 导入标准 `mcpServers` JSON，`mcp list / refresh ID / remove ID` 管理服务。`mcp enable|disable|inherit ID --project-dir DIR` 设置项目策略；不带项目时 enable/disable 设置全局默认。支持 stdio、Streamable HTTP、旧 SSE 与 envRefs/headerEnv；注册和 Desktop 共用。截图任务用视觉模型并加 `--image-input`；默认拒绝审批，外部实际调用不信任服务的只读提示。配置、作用域、失败与验证限制见 [外部 MCP](../../doc/external-mcp.md)。preview.2 不提供该命令，需要新版包。

## 当前托管 Chip Runtime

CLI 与 Desktop 共用 `chip-pack.runtime`，由 Broker 披露 `chip.project.describe`、`chip.environment.check`、`chip.rtl.verify` 和 `chip.eda.execute`。安装 Pack 后，Pack Manager 从 Harbor 准备固定 EDA 镜像；Python、Verilator、Yosys 等工具在受控容器内运行，普通用户不需要宿主 Python、`uv sync` 或本地 build。需要已运行的 Docker；Linux 的受保护 Agent 还需 bubblewrap 用户命名空间。

macOS ARM64 与 Linux x86-64 已验收 RTL 断言／VCD、综合检查、真实失败、取消恢复与安装态持久化。物理设计仍需工程自有 PDK／工艺输入，工具存在不代表完整物理流程、等价性或 LVS 签核。历史 standalone `chip-pack.eda` MCP 是单独兼容路径，不是当前默认执行入口；见[共享 MCP 历史接入](../../doc/domain-mcp-integration.md)与[安装证据](../../doc/install-experience.md)。

## 按领域的测试包

`package-headless.cjs --domain chip|pcb|godot|cad|cuda` 生成只注册对应领域资源的 CLI 包。包内 `--domain` 可省略，其他领域会拒绝。领域源码、Skill、Kimi 和依赖声明随包提供，原生应用与预构建镜像由安装器从 Harbor 准备；源码包可构建或可发现工具不等于该平台具备原生资格。

当前 Chip 托管 profile 资格为 Mac ARM64／Linux x86-64，PCB、CAD、Godot 与 CUDA 远程客户端为 Mac ARM64。PCB 复用 PCBbench 设计工具与 Skill，普通项目无需 seed 或评分，KiCad 和 gateway 由 Harbor 准备且容器需 Docker；检查不代替完整电气或制造签核。CAD 由 FreeCAD 与 ezdxf 容器组成，AutoCAD 可选。Godot 保持声明的结构验证 profile。CUDA bundle 是用户自有 kernel 工程的远程客户端，需要管理员提供配对认证的 Compiler/Evaluator 服务；RTX 4090 是已实测 GPU，worker 镜像留在私有 Harbor，客户端无需 registry 凭据或本机 CUDA 工具链。历史 Release 的归档数量与依赖按当时版本说明，详见[下载与构建](../../doc/domain-cli-downloads.md)。

## 会话资源保护

CLI 与同一配置目录的 Desktop/其他 CLI 共用执行和常驻额度，默认 4/6；达到上限时以既有错误事件和非零退出码明确拒绝，不启动原生 Prompt。单次 CLI 结束时关闭 Kimi 并释放额度，保留聊天和原生上下文供恢复。额度、内存准入、配置项和真实进程压测见[多会话资源保护](../../doc/session-resource-guards.md)。

真实运行在所有领域中提供 project.initialize、project.files.read/apply、project.tasks.inspect、project.task.run。空目录无需专业配置；共享 project.work Skill 用 harness.tasks.json 声明任务、读失败并修复重跑。格式、历史与离线限制见[共享工程底座](../../doc/shared-workspace.md)。

Pack 声明的托管运行环境由 `domains install/update` 从 Harbor 准备并校验；`domains repair DOMAIN` 检查与修复，`domains list` 报告实际就绪状态。Apple Silicon CAD 与 Desktop 共用固定 FreeCAD 安装及 DXF 容器。安装态使用无需手工 Python 环境；Docker 与 CUDA 管理员远程服务仍是明确前提。见[macOS CAD 安装记录](../../doc/macos-cad-distribution.md)。

`doctor --project-dir DIR --domain DOMAIN` runs without model credentials and records a read-only environment Action. It probes protected local execution, declared executables/dependency roots and available offline Docker images. Exit 2 means a required prerequisite is missing. Shared tools include `project.environment.inspect`; input selection, local read permissions and approval previews are documented in [Shared workspace](../../doc/shared-workspace.md).

## 内置远程体验

`remote status|connect|use|sync|task|cancel` 与桌面共用项目运行配置。用户无需手填服务名或 URL，首次上传需选择文件并显式传入 `--confirm-upload`。公网与登录配置留空时显示尚未配置；内部连接、原生检查验收和当前限制见[内置远程运行](../../doc/remote-execution.md)。

任务生命周期已由共享 `harness-application` TaskService 负责；领域源码、声明与 Skill 来自固定 Domain Packs 消费包，原生版本和平台限制见[迁移说明](../../doc/shared-task-and-pack-consumption.md)。独立叶子工具的历史 Release 保持其原有安装路径。

## 任务成果

`results_changed` 和 `results_ready` JSONL 行提供共享 TaskService 的请求归属、稳定成果组 ID、展示 revision、selection 与实际文件引用；终态记录含 `results`。分组不依赖 Agent 调用选择工具。普通文件无工程 Verifier 时保留 `not_run`，部分失败不移除已产生文件；历史检查不会随展示选择变成新版本验收。CLI 不加载 Electron／Viewer UI。[契约、可选工具和验收](../../doc/task-results.md)。
