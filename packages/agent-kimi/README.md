# Kimi agent adapter

Thin integration around `@moonshot-ai/kimi-agent-sdk`, pinned to `0.1.8` in this package and the root lockfile. It will map sessions, events, tool registration, approvals, interruption, and recovery where supported by the SDK. Validate the actual API before claiming a capability.

当前已接入会话启动、流式文本、工具事件、审批与中断入口。每次 Broker Scope 变化时创建新会话，并只注册当前 Scope 对应的 Harness 外部工具；工具处理器再次校验当前 Scope。需要本机 Kimi CLI 才能做真实会话验证。
