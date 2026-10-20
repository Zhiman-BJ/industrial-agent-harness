# Electron 真实点击进展 — 2026-10-20

本轮已在用户正常 Terminal 启动的真实 Electron 窗口中完成未同步聊天入口与输入验证，**完整点击验收仍为 blocked**。本记录追加在 [05:35 UTC 启动探测](../electron-click-readiness-20261020.json)之后：早期工具启动收到 SIGABRT、没有窗口的结果保留；后来正常 Terminal 启动成功，不再把“没有可用窗口”写成本轮当前阻塞。

## 对象与实际操作

当前工作区锚定 `546b41efcdf36f200739d1b89276418cba6481bf`；此次窗口运行的是此前 `a283fec5bbe47dbdd1c263da38c25258b4a95105` / 文档提交 `cf15cd2f9f6d4765feffc42c1b6d1bc7751fa5a5` 对应的源码构建。其后工作区快进仅合入 CI 分发变更，未将旧构建冒充重新构建的 546b41 产品包。Electron 44.0.0，macOS arm64；依赖仍有早期探测所记录的共享 node_modules 条件，不代表干净安装或正式产品包资格。

通过 CUA 原生界面真实点击创建独立 CAD 工程“PR230 Electron CAD 验收”，目录为 `/private/var/folders/z0/8fqzv4jn6zb32j82pxz8mw2r0000gn/T/pr230-ui-cad-W0oSOJ/project`。在项目详情选择远端，界面显示“已连接”；没有选择任何同步文件，直接点击“新建聊天”，并在 UI 将聊天命名为“远端批量授权点击验收”。聊天处于“请求审批”，状态为“按需准备文件”。

随后在工程任务输入框填写合成任务，真实观察到“发送任务”按钮由禁用变为可用；**没有点击发送**，取证后已清空草稿，窗口保留。未发生模型调用、本地文件读取、批量/编辑审批、上传或远端工程执行。零上传与零工程调用是本轮操作记录和未发送状态的结论，并非独立网络抓包计数；“已连接”只证明当时连接状态显示，不能证明远端 CAD 可用。

只读磁盘核对确认，该独立工程仍仅有 `recipe.json`，607 bytes，SHA-256 为 `1f9fdd40a5e462caec414574042f97e5dba38fe20490cbc7a8517d784cc15b82`；没有创建 canonical Action 或 Artifact 文件。这是宿主侧取证，不算 Agent 读取本地工程用例通过。

## 用例判定

| 用例或子项                  | 当前判定       | 证据与剩余事项                                                              |
| --------------------------- | -------------- | --------------------------------------------------------------------------- |
| RE-E01 窗口、未同步创建聊天 | pass（仅子项） | 实际窗口、远端按需准备、新聊天见截图 01                                     |
| RE-E01 输入、发送按钮可用   | pass（仅子项） | 截图 02 与可访问性观察；未发送                                              |
| RE-E01 完整用例             | blocked        | 尚未发送、读取本地工程或验证独立未配置/离线分支                             |
| RE-E02–RE-E11               | blocked        | `isolated-ui-model-profile-required`；尚未进入审批与远端任务流程            |
| RE-E06 / RE-E07 负向分支    | 另有前置缺口   | 现有成功 fixture 不覆盖拒绝续行、同任务新增范围，仍需合适受控序列或真实模型 |

准备 mock 模型时，UI 显示当前 profile 已有 MiniMax 模型及单槽密钥；保存测试 key 会覆盖现有凭据。因此取消了配置操作，没有保存或修改原密钥。完整任务待独立 UI 模型 profile 准备并正常启动后继续；本记录不要求改变 OS 权限。

本地模型 mock 只能替代模型响应，远端仍须是真实部署。现有 fixture 是单对话 11 步、仅 `/v1/chat/completions` 的严格序列；独立模型连接测试可能消费它。现有 headless runner 会程序化批准，不能当作界面点击驱动或即插即用 UI bootstrap。具体步骤和控件见 [Electron 点击矩阵](../../../qa-runbook/remote-execution.md#electron-点击矩阵)。

## 保留证据

- [progress.json](progress.json)：逐用例状态、构建身份、观察边界及证据 SHA-256。
- [01-unsynced-chat.png](01-unsynced-chat.png)：未同步空白聊天，时间以 JSON 中原始文件 mtime 辅助定位。
- [02-unsynced-send-enabled.png](02-unsynced-send-enabled.png)：合成任务已填写、发送按钮可用。
- [ui-entry-observation.txt](ui-entry-observation.txt)：CUA 可访问性树的明确节选，仅保留本次项目、聊天及 composer，移除了其他项目的绝对路径和无关条目。截图侧栏仅保留原画面中的通用示例工程名称，未含密钥。

尚无本轮 canonical Action/Artifact/Verification、上传 snapshot 或远端 request/session 证据。此前[真实共享层远端验收](../live-acceptance-20261020/README.md)已通过，但不能补记为本轮点击通过。后续仍须完成真实发送、本地读取、一次 batch 与一次 local edit 点击、第二次同步与 CAD、成果/ID 对照及独立负向、重开和清理场景。
