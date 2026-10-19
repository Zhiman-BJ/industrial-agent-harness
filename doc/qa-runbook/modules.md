# 产品模块验收矩阵

先遵守[执行协议](protocol.md)，再完成[分层门禁](tiers.md)。本页的模块检查补充产品路径，不能把定向测试通过写成 T0–T6 全量通过。每条用例记录 `ID / pass|fail|blocked|skipped / 平台 / 完整 SHA 与 dirty 快照 / Pack 身份 / 证据 / 缺口`。

| 模块 | 近期行为与验收重点 | 自动入口与门禁 | 仍需手工或真实环境 |
| --- | --- | --- | --- |
| [WB 工作台、项目与聊天](workbench-project-chat.md) | 项目目录与领域绑定、聊天恢复、并行与审批、模态键盘、语言布局、浏览器 | T1；T2 ui/chats/parallel/language/messages/browser；T4 chat-resume、session 与 background | OS 窗口/输入法、真实模型连续会话、浏览器自动操作授权 |
| [MA 模型与账号](models-account.md) | 配置广播、单次登录、按服务 Token、取消/退出与本地可用 | T1；T2 model-sync/account/gui-settings；独立 account-login workflow | 系统浏览器与生产回调、真实模型服务、打包安全存储 |
| [DR 领域安装、资源与 MCP](domains-resources-mcp.md) | 五域展示、签名 Pack、release 镜像、三态策略、实际工具注册与 Scope | T0 release；T1 Pack/策略；T2 mcp/external-mcp/logs/install-experience；T3；T4 installed；T5 | 真实冷安装、Docker engine、领域软件与工程验收、失败回滚 |
| [RE 远程执行](remote-execution.md) | 空配置、精确上传确认、状态/取消、未知提交恢复与事实回读 | T1 remote/account-remote/CLI；T2 ui；受控服务回归 | 实际部署的端到端联通；生产账号授权仍未验收 |
| [VR Viewer 与成果](viewers-results.md) | Registry、只读导航/全屏、版本绑定、附件/检查、自动预览边界 | T0 架构；T1 results/Viewer；T2 Viewer/results；T4 真 FreeCAD/成果 | 每种格式真实文件、目标平台图形/打包路径、变化与失败可见性 |
| [DP 诊断与打包](diagnostics-packaging.md) | 只读日志、doctor/inspect-log、安装包身份、证据收集 | T1 diagnostic/CLI；T2 logs；T4 headless；T5/T6 | 脱敏审查、真实安装首次启动；#209 的一键诊断包未进 main |
| [PF 性能、崩溃与恢复](performance-recovery.md) | 首个可用画面、大聊天/文件、布局/内存循环、退出无孤儿、renderer/main 异常、取消与重启持久化 | T1 事件/历史/有界读取/关停；T2 ui/parallel 的 reload 及 Renderer 强制崩溃后测试显式 reload；T4 Kimi 死亡/恢复；额外 maintenance benchmark/stress | 无统一性能阈值、自动自愈或 main crash gate；持续内存与跨平台无孤儿需手工证据，全部发现汇总到同一 issue |

模块页均提供实际命令、手工步骤、边界、失败恢复、证据与覆盖缺口。已有历史验收只对其原 SHA/包/平台有效，不继承为本次通过。变更涉及多个模块时取相关行的并集；公共 Runtime/TaskService/账号变化仍须完整共享层回归。

性能与崩溃场景是第七个横切模块：涉及聊天、文件/Viewer、布局或生命周期时同时选 PF 对应行。采样值与正确性判据分别记录；未约定阈值不能宣称性能合格。本轮发现、修复和回归统一维护在主报告指定的同一个 issue。

[返回总入口](../qa-runbook.md)
