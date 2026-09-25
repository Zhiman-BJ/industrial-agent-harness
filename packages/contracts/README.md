# Contracts

Shared types and schemas for project identity, agent events, domain runs, artifacts, capabilities, and errors. Keep contracts independent of UI and runtime implementations.

当前有工件文件观察、观察状态与最小 Checkpoint 的 Zod schema。状态只说明文件路径和内容哈希已核对，`verificationStatus` 固定为 `not_run`。Run、Action、真实工程 Verification 与领域 State 的正式契约仍需在 Industrial Core Vertical Slice 中补齐。
