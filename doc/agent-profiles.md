# Agent 配置

2026-10-10：当前源码在能力中心提供 Agents，CLI 使用同一配置与任务服务。
角色控制职责指令、工具选择、注册领域 Skills 和允许委派的子角色。模型、
API、思考参数仍使用现有模型设置，角色不单独配置模型。

## 角色来源与入口

| 来源 | 行为 |
| --- | --- |
| Kimi 内置 | Default、Coder、Explorer、Planner；只读。完整提示词由固定 Kimi 内核管理，因此不提供复制为自定义角色。 |
| Domain Pack | 指令、领域与 Skill 引用由 Pack owner 维护；显示来源版本，只读，可复制为独立自定义角色。 |
| 自定义 | 创建、编辑、复制和删除；可以限定一个领域或适用于所有领域。复制后的角色独立保存，不跟随原角色更新。 |

在能力中心管理角色，在项目详情设置默认角色，在本机项目的空白聊天选择本次
角色。项目默认值按真实项目目录与领域保存；改变默认值不改变已有聊天。
桌面远程项目当前没有角色选择入口，远程协议尚未转发这些配置。

自定义角色与项目默认值保存在配置目录的 `agent-profiles.json`。
Desktop/CLI 默认共用 `~/.industrial-agent-harness`；
`INDUSTRIAL_HARNESS_CONFIG_DIR` 可隔离配置。CLI 管理命令另支持 `--config-dir`。
JSON 配置的读改写由 SQLite 跨进程锁保护，避免 Desktop 与 CLI 同时保存时
互相覆盖。损坏配置会报错，内置和 Pack 角色不能原地改写。

## 配置语义

- `name`、`description`、`instructions` 描述名称、用途和附加职责指令。
  `domain` 为已注册领域 ID，或 `*`。全局角色只能引用全局资源；领域角色
  可以引用本领域及全局资源。全局角色的子角色也必须为全局或内置角色。
  未知资源、循环委派和不兼容引用会被拒绝；编辑子角色时同时检查所有引用
  它的祖先角色，防止一次修改破坏已有配置。
- `tools` 与 `disallowedTools` 使用固定 Kimi Code 2.1.1 的公开工具名或
  支持的 MCP 模式。界面列出可选工具；配置不会启用当前不存在的内核功能。
- `skills` 使用 Harness 注册的 Skill ID。主角色的允许列表与有效的全局
  默认／项目覆盖、当前 Broker Scope 取交集；项目显式设置可覆盖全局默认。
  子角色继承主会话的 Skill 范围，不获得独立 Skill 授权。此字段约束注册
  领域技能披露，不是任意文件访问控制，也不隔离 Kimi 原生发现的项目技能。
- `subagents` 引用角色 ID，包括可用内置角色。保存与选择时检查引用关系；
  子任务仍由 Kimi 原生机制运行。

省略可选列表表示继承默认；`tools: []`、`skills: []`、`subagents: []`
分别不选择相应资源。`disallowedTools: []` 表示没有额外禁用项。
角色指令附加到基础提示词，不替换 Harness 工业约束。工具选择不能越过
Broker、Runtime、审批或进程沙箱；角色完成任务不等于工程验证通过。

## 聊天与恢复

选择角色时保存主角色、显式引用的子角色闭包及来源修订。聊天出现首条任务
记录后，角色配置固定；包括已经完成 Scope 解析、尚未运行模型的任务。
需要换角色时新建聊天。角色编辑、删除和 Pack 升级不改写已有聊天的快照。
旧版聊天没有角色记录时使用内置 Default，不套用之后设置的项目默认角色。

角色快照进入 Kimi 会话兼容身份，重启后使用同一份角色指令恢复。Pack 卸载
或升级后，旧指令仍保留，但执行继续依赖当前可用的 Pack、Skill 和权限；
快照不会恢复已卸载工具，也不会覆盖新的资源禁用设置。

## CLI

```sh
pnpm cli agents list --project-dir /path/to/project --domain chip
pnpm cli agents save --file /path/to/agent.json
pnpm cli agents default --project-dir /path/to/project --domain chip --id AGENT_ID
pnpm cli run --project-dir /path/to/project --domain chip --agent AGENT_ID --task 'Inspect the project'
pnpm cli agents delete --id AGENT_ID
```

保存文件的最小示例：

```json
{
  "name": "Reviewer",
  "description": "Review changes with evidence.",
  "domain": "*",
  "instructions": "Explain findings and cite the relevant files."
}
```

新增时省略 `id`，返回分配的 `custom:...` ID；更新时带该 ID，提交完整定义。
`run --chat-id` 续聊沿用已保存角色；已开始的聊天不能用不同 `--agent` 改写。
`--scope-only` 可预览角色影响后的注册范围，无需模型，也不创建聊天。

Node SDK 的 `client.run({ task, agentId })` 可选择角色，映射同一 CLI `--agent`，
沿用项目绑定与聊天冻结规则。SDK 未提供角色配置 CRUD API；配置仍通过能力
中心或 `agents` 命令管理。见 [SDK 文档](sdk.md)。

## 领域维护与验证边界

领域角色正文只在 [Domain Packs owner](https://github.com/Zhiman-BJ/industrial-domain-packs/blob/328256cd66d1ee5158095438f60dcaa7621536ef/docs/agents.md)
维护。Harness 固定消费 owner 0.6.0 的 commit 与内容摘要，将普通 Markdown
转换为 Kimi 角色文件；分发包携带声明、正文和文件摘要。旧版无 `agents`
字段的包继续可读。资源路径、符号链接、大小、UTF-8、哈希及引用关系均检查。

相关门禁位于 Core／TaskService、Agent Kimi、Pack Manager 和 Domain Skills
测试，真实内核入口为 `tests/integration/agent-profiles-kimi.test.cjs`，桌面入口为
`pnpm --filter @industrial-agent-harness/desktop test:agents`。这些检查不扩展原生
工程或平台资格。本次为源码接入，新的 Pack 分发版本及对应安装器尚未发布。
