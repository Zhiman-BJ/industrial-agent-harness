# Domain Pack 扩展契约

Domain Pack 是独立安装、升级和卸载的领域资源单位。当前公开实现支持版本化 `.hpack`、
签名目录、摘要校验、共享安装库、使用租约及原子激活。包内可声明 Capability、完整自有
Skill 目录、既有 Provider 桥接和注册的工业 Runtime。第三方 Skill-only Pack 可由安装库
动态发现，无需修改 Core；独立教程见 [Pack 开发与发布](pack-authoring.md)。

## 已实现的容器与安装协议

```text
pack-source/
├── bundle.json
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── provenance/runtime-distribution.json  # 声明容器镜像时必需，保持 owner 原文
├── skills/<skill-id>/
│   ├── SKILL.md
│   ├── references/...
│   ├── assets/...
│   └── scripts/...
└── domain-packs/<provider-directory>/...
```

树中附属目录与 `SKILL.md` 同级。`bundle.json` 的容器版本为数字 `schemaVersion: 1`，
Core 兼容版本为 `coreApi: 1`；包括 Domain ID、标签、版本、Capabilities、Skills、Provider Packs。
Skill 相对路径与 Provider 目录必须安全；资源不得使用 symlink 或特殊文件。Skill 单文件上限
8 MiB、单树 32 MiB、2,000 文件，整个容器另受 128 MiB 压缩、512 MiB 内容和 20,000 文件限额约束。

构建时校验 manifest、引用、完整目录、大小与路径，再记录每文件 SHA-256；安装核对目录签名、
平台、压缩包摘要、文件摘要和必需入口，完成后原子更新活动版本。失败与不兼容版本保留旧活动版本；
使用租约阻止任务运行中更换或删除 Pack。新安装保存资源校验回执，Registry 扫描隔离改动、缺失、
越界或 symlink 的 Domain。旧 v1 安装无回执时继续检查文件边界，重装同一归档后生成回执。
本机拥有者能够改写安装库及回执；回执是完整性检查，不是防御本机恶意管理员的信任边界。

`bundle.json` 可选的 `containerImages` 是镜像 ID／引用数组，最多 8 项且不可重复。每项必须
在包内的 `provenance/runtime-distribution.json` 中属于该 Domain，并具有已发布的固定身份。
目录的 `containerDownloadSize` 记录所选镜像 tar 下载字节总数，供两端展示空间估算。
正式安装、更新与修复共用 Pack Manager：从 release tarball 准备镜像后再激活 Pack，
校验失败或取消保留旧版本；没有发布版本的镜像不会被构建器自动选入。
本地运行中的 Linux Docker engine 是外部前提。详见[容器镜像安装链路](container-image-installation.md)。

安装不执行归档中的脚本。已信任、注册的 Runtime 在任务创建时加载；`runtime.entry` 是 Provider
目录内 `.cjs` 相对入口，必须在归档库存中存在。公开源码登记及受信任签名安装都是代码信任边界；
签名、校验和 Registry 通过不等于为第三方代码提供了通用安全沙箱。

## 私有外部资源与公开桥接包

PCB 的公开 Pack 只含本仓桥接文件、公开引导 Skill 和固定资源来源声明，不重分发私有
PCB-bench 源码、完整设计 Skill、任务或参考答案。Skill 使用 `external` 声明：

```json
{
  "providerPackId": "pcb-bench",
  "resourcePath": "skills/pcb-design-e2e",
  "nativeToolPrefix": "pcb.bench."
}
```

用户在获得上游授权后，通过 Provider 的目录环境变量指向其已有固定 checkout。
源码态与安装态只在所选 Scope 材料化时读取外部资源，校验完整库存、逐文件摘要和汇总摘要；
缺失、改动、额外资源、越界及软链都会拒绝。构建公开发行物不需要也不读取该私有 checkout。
自有 Skill 的 refs/assets/scripts 则完整进入归档与会话，并在 Scope 更换时移除旧资源。

## 工业扩展的边界

- Stable Domain、Capability、Skill 与 Tool ID 由 Pack 提供；Core 不新增具体领域分支。
- 原生工具以 canonical ID 声明风险和验证要求，任务执行再次检查 Broker allowlist。
- StateProvider、Tool、Verifier 通过注册 Runtime 注入。工业事实采用
  [`packages/contracts`](contracts-versioning.md) 的 v1 schema，过程成功、证据不足与工程失败分别表达。
- 产物绑定项目、Run、Action 与内容身份；Viewer 只读消费，不产生验收事实。
- 依赖与平台声明反映实际验证；外部依赖缺失不能以示例结果替代执行。

共享安装机制和 Skill-only 外部扩展已经落地。第三方任意原生 Provider backend 自动加载、
跨平台专业工具完整运行环境、Viewer 插件的通用公开 API 仍有边界；现有 Provider 桥接使用
仓库登记的 backend。教程里的最小例子只演示 Skill 扩展及资源交付，不宣称新增工业领域验收。

Chip、PCB、Godot 原生接入与对应证据分别见 [Chip MCP](domain-mcp-integration.md)、
[PCB MCP](pcb-mcp-integration.md)、[Godot MCP](godot-mcp-integration.md)。PCB 已有六题原生
诊断记录，不能继续写“尚未实测”；其本地镜像、首次试跑与提示续跑结果，以及未完成的完整
电气/实体资格，见 [六题报告](pcb-bench-local-trial-2026-09-30.md)。
