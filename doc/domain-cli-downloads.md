# 按 Domain 下载 CLI 测试包

同一个 Headless Release 提供 `industrial-agent-harness-cli-chip-<tag>.tar.gz`、`industrial-agent-harness-cli-pcb-<tag>.tar.gz`、`industrial-agent-harness-cli-godot-<tag>.tar.gz` 和各自 SHA-256 校验文件。

首版分包为 [headless-v0.2.0-preview.2](https://github.com/Zhiman-BJ/industrial-agent-harness/releases/tag/headless-v0.2.0-preview.2)，历史 Release 不自动补文件。发行包从固定提交构建，`HARNESS-PACKAGE.json` 的 `sourceDirty` 必须为 `false`；此前 `dist/domain-cli-20260929` 中的本地测试包不能替代发行包。

[headless-v0.2.0-preview.3](https://github.com/Zhiman-BJ/industrial-agent-harness/releases/tag/headless-v0.2.0-preview.3) 在所有包中加入 [外部 MCP 注册](external-mcp.md)：`node industrial-harness.cjs mcp add --file mcp.json`，与 Desktop 共用 stdio/HTTP/SSE 服务、项目策略和 Kimi 审批。截图任务使用视觉模型及 `--image-input`。外部服务不受领域分包排除，软件与系统授权仍需单独准备；preview.2 不提供此入口。

[headless-v0.2.0-preview.5](https://github.com/Zhiman-BJ/industrial-agent-harness/releases/tag/headless-v0.2.0-preview.5) 更新 Chip Pack 至 0.6.1，增加 EDA 资源保护、容器清理与等价验证修复。Chip 使用者需同步重建工具镜像并更新工程配置，见 [迁移说明](../domain-packs/chip/eda-harness/docs/runtime-reliability.md)。旧归档和旧镜像不会自动更新。

| 包    | 默认领域 | 当前能力与测试依赖                                                                                                                                         |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chip  | chip     | 三个原有检查 Skill、EDA 操作 Skill、25 工具的 MCP Gateway 与 EDA Harness 固定源码；先准备 Python，工业计算再准备镜像/PDK/工程                              |
| PCB   | pcb      | 89 工具的受范围约束 MCP 与完整设计 Skill 的加载声明；实际使用需另行准备固定 PCB-bench 源码、Skill 与匹配 KiCad 镜像，见 [PCB 接入](pcb-mcp-integration.md) |
| CAD   | cad      | FreeCAD 参数化草图、拉伸、孔、布尔实体、FCStd/STEP/STL 导出与独立回读；原生计算仅验证 FreeCAD 1.1.4 macOS arm64，见 [CAD 接入](freecad-domain-pack.md)     |
| Godot | godot    | 5 个受范围约束的场景检查、导入和限时运行工具，以及两份 Skill；原生动作需注册 Godot 4 可执行文件，见 [Godot 接入](godot-mcp-integration.md)                 |

下载、校验并解压对应包：

```sh
shasum -a 256 -c industrial-agent-harness-cli-chip-<tag>.tar.gz.sha256
tar -xzf industrial-agent-harness-cli-chip-<tag>.tar.gz
cd headless-chip
node industrial-harness.cjs run --project-dir /absolute/project --task '检查工程状态' --scope-only
```

各包默认绑定所选 Domain，`--domain` 可省略；显式指定另一个领域会拒绝。只注册本领域 Capability / Skill / MCP，删除无关 Skill 与 Domain Pack 文件；Chip 之外不携带 EDA 源码或 Python 环境。
`HARNESS-PACKAGE.json` 记录领域、构建时间、来源提交、是否含未提交改动与 provider 版本。

当前源码构建的包需要 Node.js 24+，内含 Kimi Code **2.1.1**，实际 Agent 需模型 API key；可先用 `--scope-only` 测试注册。`KIMI_EXECUTABLE` 为可选的同版本覆盖，旧 Python 1.51.0 不兼容。当前三平台 Agent 使用当前用户权限，见[执行政策](local-agent-execution.md)；移除 OS 启动依赖不扩大原有 CPU/OS、安装包或领域资格。历史 Release 依赖、隔离行为及实测范围以各自说明为准，不修改历史归档。Chip MCP 仍需固定 Python 环境。

原有多领域 Headless 包继续保留供跨领域 Bench，独立 Chip Pack 也保留用于直接运行 EDA Harness。

本地构建与校验：

```sh
node scripts/package-headless.cjs --domain chip
node scripts/package-headless.cjs --domain pcb
node scripts/package-headless.cjs --domain godot
node scripts/package-headless.cjs --domain cad
node scripts/smoke-domain-cli.cjs dist
```

本次在 macOS 从不同工作目录启动四个包，验证领域默认、跨领域拒绝、资源筛选、Chip 禁用与源码存在/缺失；Chip 还验证解包后的真实 MCP。其他平台安装包与完整工程计算尚未验收。

CAD 独立包包含 FreeCAD Runtime 和 Skill；Scope/打包可跨平台验证，实际受保护建模目前仅支持 macOS arm64 + FreeCAD 1.1.4，详见 [FreeCAD 接入](freecad-domain-pack.md)。
