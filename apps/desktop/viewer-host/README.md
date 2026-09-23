# Desktop Viewer Host

Electron 内承载内置 Viewer 的 UI 容器。通过受限 preload/IPC 请求已登记 Artifact 的显示数据，管理选项卡、视口状态、加载状态和跨视图选择。它不直接读取任意本地路径，也不运行来自 Domain Pack 的 HTML、脚本或任意命令。

外部专业软件的打开入口由 Electron 主进程单独处理并明确展示启动状态。启动成功不代表文件加载成功或工程验证通过。

当前仅有结构占位。契约见 [Viewer 层设计](../../../doc/viewer-layer.md)。
