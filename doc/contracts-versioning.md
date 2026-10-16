# 工业契约版本与兼容边界

`packages/contracts` 是工程事实的唯一 schema 来源。运行时使用 Zod 4 校验，TypeScript
消费者读取同包的 `src/index.d.cts`。公开常量 `INDUSTRIAL_SCHEMA_VERSION` 为字符串 `'1'`；
Pack 容器的数字 `schemaVersion: 1`、`coreApi: 1` 是独立协议，不能相互替代。

## 当前正式数据形状

| 导出 | 关键字段及消费方 |
| --- | --- |
| `ProjectRefSchema` | 项目身份 SHA-256、领域及版本，绑定运行时工程上下文 |
| `ArtifactRefSchema` | UUID、项目/Run/Action 身份、项目相对路径、内容 SHA-256、大小、工具来源及输入内容身份，供 Runtime 产物读取与失效判断 |
| `DomainStateSchema` | UUID、领域阶段、`unverified / verified / failed / stale`、产物、输入哈希、验证身份与生成时间，供 Runtime 与 Broker 解析 |
| `RunRecordSchema` | 初始 State 身份、运行时间、过程状态及 Action 身份，供恢复与查询 |
| `IndustrialActionRecordSchema` | Run/State、工具 ID 与版本、真实参数、输入哈希、过程状态、诊断、显式产物集合及 Verification，供工业持久化 |
| `IndustrialVerificationResultSchema` | 独立验证器、`not_run / passed / failed / insufficient_evidence`、原因、指标、内容绑定的证据，供 Runtime 状态迁移 |
| `IndustrialCheckpointSchema` | 父节点、状态内容哈希、完整 State、Run/Action/Artifact 身份，供历史查询与重启恢复 |
| `ToolDescriptorSchema` | 工具 ID、版本、风险与验证器声明，供执行边界校验；修改型工具必须声明验证器 |
| `ActionRequestSchema` | 项目、领域、工具、真实参数、预期 State，供调用方建立版本化请求 |

`inputHashes` 一律为 `{ "项目内相对路径": "SHA-256" }`；路径使用 POSIX `/`，拒绝绝对路径、
`..`、空段、反斜杠和驱动器路径。Artifact 的输入身份与产物自身的 `sha256` 各有含义。
`metrics` 接受有限数字、布尔值和字符串，`evidence` 保存 Artifact UUID 和输入哈希。

Schema 拒绝未来未知版本与未知字段。`passed / failed` 必须声明独立验证器及至少一份绑定
内容身份的证据；`verified` State 必须引用 Verification。引用对象存在性、同项目归属、
内容哈希是否仍匹配，以及 Checkpoint 哈希核对由 Runtime 执行，不能仅凭 schema 通过建立事实。
过程 `completed` 不代表 Verification `passed`。

## 旧记录如何读取

`ObservedArtifactSchema / ObservedStateSchema / ContextCheckpointSchema` 保留文件观察形状。
观察产物只允许 `verificationStatus: not_run`，不会因重新读取或迁移变成工程验收。
原 `ActionRecordSchema / VerificationResultSchema` 保留无版本记录读取能力，并允许新的可选
来源字段及 `insufficient_evidence`。新工业写入必须使用对应 `Industrial*` 严格 schema；旧
Action 缺失工具版本、输入哈希和证据时，不通过严格校验，不补造缺失来源。

当前支持 v1，没有自动降级、未来版本忽略或历史验收提升。新增可选展示字段时仍需明确更新
读写方；更改事实字段含义、身份规则、必填项或枚举时，应发布新的 schema 版本并提供显式迁移，
同时用旧记录和新写入进行兼容性验证。迁移保留原始记录与证据身份。

运行 `node --test packages/contracts/tests/*.test.cjs` 验证非法路径、未来版本、缺失证据、
修改型工具验证声明及旧 Action 兼容。完整状态闭环与失效、失败、恢复在 Runtime 集成测试中验证；
契约单测不能替代原生工程验收。

## 远程沙箱同步契约

`remote.cjs` 以独立的 `REMOTE_SCHEMA_VERSION = '1'` 冻结 issue #199 P0 阶段的远程执行
契约：服务发现与 qualification、Pack 执行 profile 与策略、输入快照与上传会话、
SourceChangeSet、ArtifactBundle、调用恢复身份、同步状态机及会话绑定。它是设计契约而非
已部署能力的声明，详见[远程沙箱同步契约](remote-sync-contract.md)。

## 可选成果展示协议

版本字符串 `1` 的 ToolPresentation／ActionPresentation／ResultGroup／ResultSelection 是独立应用展示协议，不扩充 Artifact 或 Verification 的工程语义。局部输出名先绑定本 Action 的真实产物，替代与检查关系再校验确切输入内容；宿主绑定项目、chat、请求身份。未知版本或不合法声明只禁用该组并保留诊断及事实记录。详见[任务成果契约](task-results.md)。
