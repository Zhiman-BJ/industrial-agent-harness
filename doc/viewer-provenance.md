# Viewer 代码来源

`packages/viewer-builtin/src/layout`、`src/netlist`、`src/waveform` 的初始代码于 2026-09-23 从本地 `silicon-lens-harness` demo 工作树迁入。迁移时保留 KLayout、netlistsvg 和 Surfer 的渲染路径，将 UI 所用的旧 `replayApi` 命名调整为新桌面端的 `viewerHost`，并调整模块路径。Viewer CSS 同样来自该 demo。

版图 Python 模块使用 KLayout 的 Python API；网表 worker 依赖锁定的 `netlistsvg@1.0.2`；波形模块包含官方站点的 Surfer JS/WASM 快照。Surfer 的详细来源、哈希与 EUPL-1.2 许可证保留在 `packages/viewer-builtin/src/waveform/surfer/`。

旧 demo 的回放系统、项目注册表和完整 Electron IPC 不随 Viewer 源码复制。新桌面端应通过项目/Artifact 身份核验后调用 Viewer，并保持产物来源与显示缓存分离。
