# 版图流式显示验收边界

2026-10-19。固定输入见 [fixtures.json](fixtures.json)，生产后端结果见 [原始报告](tile-stress-report.json)与[摘要](summary.json)：301 次请求，192 次精确 tile 对照和 64 次接缝检查通过；概览/局部精确、缓存、generation、陈旧请求撤销、单 worker 与源摘要保持均通过。近千万逻辑实例不等于全量三角形驻留。

另已通过浮动原点、DBU 网格深度与世界焦点保持的纯前端回归 25/25，以及实际 HTTP 生产 Host 的 metadata（32 层）→ cancel → overview → detail 链路；首层 detail 返回 66 个三角形。这些结果不计为 GPU 或原生界面证据。

最终合并后的验证：Desktop TypeScript/Vite 生产构建通过；Viewer 全套 89/89（KLayout Python 已启用，无跳过）、源快照及窗口生命周期 16/16、架构检查 48/48 通过，`git diff --check` 通过。25 项前端回归包含在 Viewer 的 89 项中，不重复计数。重启后的本地预览页面与入口模块均返回 HTTP 200，生产 tile 链路再次返回真实概览和 66 三角形局部精确结果。

Chrome 实际 WebGL 预览与新版原生 Electron 验收仍待完成。当前输入上限 128 MiB，KLayout 完整解析；无外存或 GPU 实例复用资格。RSS 采样/自报为软保护，不是 OS 硬隔离。详细范围见 [Viewer 文档](../../viewer-layer.md#版图-25d-示意层叠)。


公开发布时，`fixtures.json` 中原本的本机临时路径统一为 `synthetic-fixtures/` 标识；报告的 manifest 引用指向本目录 `fixtures.json`。这些是输入来源标识，不表示合成 GDS 已随证据提交。生成器位于 `packages/viewer-builtin/tests/tools/generate-layout-stress.py`。本次只整理路径元数据，测量值、输入 SHA-256 及原验收结论未变，也没有重新执行历史工作负载。
